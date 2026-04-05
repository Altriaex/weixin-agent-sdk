import crypto from "node:crypto";
import os from "node:os";

import type {
  Agent,
  AgentConfigOptionsResult,
  AgentConfigSetResult,
  AgentStatusResult,
  ChatContext,
  ChatRequest,
  ChatResponse,
} from "weixin-agent-sdk";
import type {
  ContentBlock,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionId,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import {
  buildNativeModelUpdateCommand,
  buildCodexStatusSummary,
  findModelConfigOption,
  formatCodexContextWindow,
  findReasoningConfigOption,
  getSdkConversationConfigOptions,
  resolveAcpConfigOption,
} from "./acp-agent-state.js";
import {
  formatCodexRateLimitWindow,
  getCodexStatusArtifacts,
} from "./codex-session-log.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import {
  mapPermissionDecisionToAcpOutcome,
  mapPermissionRequestToSdk,
} from "./permission-bridge.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

const CANCELLED_OPERATION_TEXT = "当前操作已取消";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

class ConversationResetError extends Error {
  constructor(conversationId: string) {
    super(`ACP conversation reset while initializing: ${conversationId}`);
  }
}

function getConfigValue(option?: SessionConfigOption): string {
  if (!option) {
    return "unknown";
  }
  return option.type === "boolean" ? String(option.currentValue) : option.currentValue;
}

function formatHomeRelativePath(value: string): string {
  const homeDir = os.homedir();
  if (value === homeDir) {
    return "~";
  }
  if (value.startsWith(`${homeDir}/`)) {
    return `~${value.slice(homeDir.length)}`;
  }
  return value;
}

function formatPermissions(
  sandboxType?: string,
  approvalPolicy?: string,
): string {
  if (!sandboxType && !approvalPolicy) {
    return "unknown";
  }
  return `Custom (${sandboxType ?? "unknown"}, ${approvalPolicy ?? "unknown"})`;
}

function formatAccount(email?: string, planType?: string): string | undefined {
  if (!email && !planType) {
    return undefined;
  }

  if (!planType) {
    return email;
  }

  const normalizedPlan = planType.slice(0, 1).toUpperCase() + planType.slice(1);
  return email ? `${email} (${normalizedPlan})` : normalizedPlan;
}

function pickFiveHourLimit(rateLimits?: {
  primary?: { windowMinutes: number };
  secondary?: { windowMinutes: number };
}): "primary" | "secondary" | undefined {
  if (rateLimits?.primary?.windowMinutes === 300) {
    return "primary";
  }
  if (rateLimits?.secondary?.windowMinutes === 300) {
    return "secondary";
  }
  return rateLimits?.primary ? "primary" : rateLimits?.secondary ? "secondary" : undefined;
}

function pickWeeklyLimit(rateLimits?: {
  primary?: { windowMinutes: number };
  secondary?: { windowMinutes: number };
}): "primary" | "secondary" | undefined {
  if (rateLimits?.secondary && rateLimits.secondary.windowMinutes >= 7 * 24 * 60) {
    return "secondary";
  }
  if (rateLimits?.primary && rateLimits.primary.windowMinutes >= 7 * 24 * 60) {
    return "primary";
  }
  return undefined;
}

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the weixin-agent-sdk Agent interface.
 */
type AcpConversationState = {
  conversationId: string;
  sessionId?: SessionId;
  createdAt: number;
  sessionReady: Promise<SessionId>;
  resetRequested: boolean;
  activePrompt?: {
    turnId: string;
    startedAt: number;
    context?: ChatContext;
    completion: Promise<void>;
  };
  pendingPermission?: {
    requestId: string;
    toolTitle?: string;
    toolKind?: string;
    options: RequestPermissionRequest["options"];
  };
  usage?: {
    size: number;
    used: number;
    cost?: {
      amount: number;
      currency: string;
    } | null;
  };
  sessionLogPath?: string;
  configOptions?: SessionConfigOption[];
};

type ReadyAcpConversationState = AcpConversationState & {
  sessionId: SessionId;
};

export class AcpAgent implements Agent {
  private connection: AcpConnection;
  private conversations = new Map<string, AcpConversationState>();
  private sessionStates = new Map<SessionId, AcpConversationState>();
  private options: AcpAgentOptions;

  constructor(options: AcpAgentOptions) {
    this.options = options;
    this.connection = new AcpConnection(options, {
      onExit: () => {
        log("subprocess exited, clearing session cache");
        this.conversations.clear();
        this.sessionStates.clear();
      },
      onRequestPermission: async (params) => this.handlePermissionRequest(params),
      onSessionUpdate: (notification) => this.handleSessionUpdate(notification),
    });
  }

  async chat(request: ChatRequest, context?: ChatContext): Promise<ChatResponse> {
    const blocks = await convertRequestToContentBlocks(request);
    if (blocks.length === 0) {
      return { text: "" };
    }

    try {
      const preview = request.text?.slice(0, 50) || (request.media ? `[${request.media.type}]` : "");
      const { response, stopReason } = await this.runPrompt(
        request.conversationId,
        blocks,
        `prompt: "${preview}"`,
        context,
      );
      if (stopReason === "cancelled") {
        return { text: "" };
      }
      log(`response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""}`);
      return response;
    } catch (error) {
      if (error instanceof ConversationResetError) {
        return { text: "" };
      }
      throw error;
    }
  }

  async getStatus(conversationId: string): Promise<AgentStatusResult> {
    return this.withResetCancelled(async () => {
      const state = await this.getOrCreateConversationStateForConversation(conversationId);
      const codexStatus = await getCodexStatusArtifacts({
        sessionId: state.sessionId,
        createdAt: state.createdAt,
        sessionLogPath: state.sessionLogPath,
      });
      const modelOption = findModelConfigOption(state.configOptions);
      const reasoningOption = findReasoningConfigOption(state.configOptions);
      const cwd = codexStatus.sessionMetadata?.cwd ?? this.options.cwd ?? process.cwd();
      const fiveHourLimitKey = pickFiveHourLimit(codexStatus.rateLimits);
      const weeklyLimitKey = pickWeeklyLimit(codexStatus.rateLimits);

      if (codexStatus.exactSessionLogPath) {
        state.sessionLogPath = codexStatus.exactSessionLogPath;
      }

      return {
        text: buildCodexStatusSummary({
          sessionId: state.sessionId,
          model:
            (modelOption && getConfigValue(modelOption)) ??
            codexStatus.sessionMetadata?.model ??
            codexStatus.cliConfig?.model,
          reasoningEffort:
            (reasoningOption && getConfigValue(reasoningOption)) ??
            codexStatus.sessionMetadata?.reasoningEffort ??
            codexStatus.cliConfig?.reasoningEffort,
          summaryMode:
            codexStatus.sessionMetadata?.summaryMode ??
            codexStatus.cliConfig?.summaryMode ??
            "auto",
          cwd: formatHomeRelativePath(cwd),
          permissions: formatPermissions(
            codexStatus.sessionMetadata?.sandboxType,
            codexStatus.sessionMetadata?.approvalPolicy,
          ),
          account: formatAccount(
            codexStatus.accountProfile?.email,
            codexStatus.rateLimits?.planType ?? codexStatus.accountProfile?.planType,
          ),
          contextWindow: formatCodexContextWindow(
            state.usage,
            codexStatus.sessionMetadata?.contextWindowSize,
          ),
          fiveHourLimit: formatCodexRateLimitWindow(
            fiveHourLimitKey ? codexStatus.rateLimits?.[fiveHourLimitKey] : undefined,
          ),
          weeklyLimit: formatCodexRateLimitWindow(
            weeklyLimitKey ? codexStatus.rateLimits?.[weeklyLimitKey] : undefined,
          ),
        }),
      };
    }, {
      text: CANCELLED_OPERATION_TEXT,
    });
  }

  async getConfigOptions(conversationId: string): Promise<AgentConfigOptionsResult> {
    return this.withResetCancelled(async () => {
      const state = await this.getOrCreateConversationStateForConversation(conversationId);
      const sdkOptions = getSdkConversationConfigOptions(state.configOptions);

      if (sdkOptions.length === 0) {
        log(`model config fallback to native command: conversation=${conversationId}`);
        return {
          text: await this.runTextCommand(conversationId, "/model", "model"),
          options: [],
        };
      }

      return {
        options: sdkOptions,
      };
    }, {
      text: CANCELLED_OPERATION_TEXT,
      options: [],
    });
  }

  async setConfigOption(
    conversationId: string,
    configId: string,
    value: string,
  ): Promise<AgentConfigSetResult> {
    return this.withResetCancelled(async () => {
      const state = await this.getOrCreateConversationStateForConversation(conversationId);
      const conn = await this.connection.ensureReady();
      const configOptions = state.configOptions;
      const option = resolveAcpConfigOption(configOptions, configId);
      if (!option) {
        const command = buildNativeModelUpdateCommand(configId, value);
        if (!command) {
          throw new Error(`ACP config option is unavailable: ${configId}`);
        }
        log(`model update fallback to native command: conversation=${conversationId} value=${value}`);
        return {
          text: await this.runTextCommand(conversationId, command, "model-update"),
        };
      }

      const response =
        option.type === "boolean"
          ? await conn.setSessionConfigOption({
              sessionId: state.sessionId,
              configId: option.id,
              type: "boolean",
              value: value === "true",
            })
          : await conn.setSessionConfigOption({
              sessionId: state.sessionId,
              configId: option.id,
              value,
            });

      this.updateConversationConfigOptions(
        conversationId,
        state,
        response.configOptions,
        "setSessionConfigOption",
      );
      return {};
    }, {
      text: CANCELLED_OPERATION_TEXT,
    });
  }

  private async withResetCancelled<T>(
    task: () => Promise<T>,
    cancelledResult: T,
  ): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof ConversationResetError) {
        return cancelledResult;
      }
      throw error;
    }
  }

  private createConversationState(
    conversationId: string,
  ): AcpConversationState {
    const ready = createDeferred<SessionId>();
    const state: AcpConversationState = {
      conversationId,
      createdAt: 0,
      sessionReady: ready.promise,
      resetRequested: false,
    };
    this.conversations.set(conversationId, state);
    void this.initializeConversationState(state, ready);
    return state;
  }

  private async initializeConversationState(
    state: AcpConversationState,
    ready: Deferred<SessionId>,
  ): Promise<void> {
    const conversationId = state.conversationId;
    try {
      const conn = await this.connection.ensureReady();
      if (state.resetRequested) {
        ready.reject(new ConversationResetError(conversationId));
        return;
      }

    log(`creating new session for conversation=${conversationId}`);
      const res = await conn.newSession({
        cwd: this.options.cwd ?? process.cwd(),
        mcpServers: [],
      });
      state.createdAt = Date.now();
      log(`session created: ${res.sessionId}`);
      state.sessionId = res.sessionId;
      if (state.resetRequested) {
        log(`discarding reset session for conversation=${conversationId} (session=${res.sessionId})`);
        ready.reject(new ConversationResetError(conversationId));
        return;
      }

      this.sessionStates.set(res.sessionId, state);
      this.updateConversationConfigOptions(conversationId, state, res.configOptions, "newSession");
      ready.resolve(res.sessionId);
    } catch (error) {
      if (this.conversations.get(conversationId) === state) {
        this.conversations.delete(conversationId);
      }
      ready.reject(error);
    }
  }

  private requireUsableConversationState(
    conversationId: string,
    state: AcpConversationState,
  ): ReadyAcpConversationState {
    if (state.resetRequested) {
      throw new ConversationResetError(conversationId);
    }
    if (!state.sessionId) {
      throw new Error(`ACP session is missing for conversation=${conversationId}`);
    }
    return state as ReadyAcpConversationState;
  }

  private async getOrCreateConversationState(
    conversationId: string,
  ): Promise<ReadyAcpConversationState> {
    const existing = this.conversations.get(conversationId);
    const state = existing && !existing.resetRequested
      ? existing
      : this.createConversationState(conversationId);

    await state.sessionReady;
    return this.requireUsableConversationState(conversationId, state);
  }

  private async getOrCreateConversationStateForConversation(
    conversationId: string,
  ): Promise<ReadyAcpConversationState> {
    return this.getOrCreateConversationState(conversationId);
  }

  private async runPrompt(
    conversationId: string,
    prompt: ContentBlock[],
    logLabel: string,
    context?: ChatContext,
  ): Promise<{
    response: ChatResponse;
    stopReason: string;
    state: ReadyAcpConversationState;
  }> {
    const state = await this.getOrCreateConversationState(conversationId);
    const promptCompletion = createDeferred<void>();
    const activePrompt = {
      turnId: crypto.randomUUID(),
      startedAt: Date.now(),
      context,
      completion: promptCompletion.promise,
    };
    state.activePrompt = activePrompt;
    this.assertPromptStillActive(conversationId, state, activePrompt);

    log(`${logLabel} (session=${state.sessionId})`);

    const collector = new ResponseCollector();
    this.connection.registerCollector(state.sessionId, collector);
    try {
      const conn = await this.connection.ensureReady();
      this.assertPromptStillActive(conversationId, state, activePrompt);
      const result = await conn.prompt({ sessionId: state.sessionId, prompt });
      const response = await collector.toResponse();
      return {
        response,
        stopReason: result.stopReason,
        state,
      };
    } finally {
      promptCompletion.resolve();
      if (state.activePrompt === activePrompt) {
        state.activePrompt = undefined;
      }
      state.pendingPermission = undefined;
      this.connection.unregisterCollector(state.sessionId);
    }
  }

  private assertPromptStillActive(
    conversationId: string,
    state: ReadyAcpConversationState,
    activePrompt: NonNullable<AcpConversationState["activePrompt"]>,
  ): void {
    if (
      state.resetRequested ||
      this.conversations.get(conversationId) !== state ||
      state.activePrompt !== activePrompt ||
      this.sessionStates.get(state.sessionId) !== state
    ) {
      throw new ConversationResetError(conversationId);
    }
  }

  private async runTextCommand(
    conversationId: string,
    command: string,
    logLabel: string,
  ): Promise<string> {
    const { response, stopReason } = await this.runPrompt(
      conversationId,
      [{ type: "text", text: command }],
      logLabel,
    );

    const text = response.text?.trim();
    if (text) {
      return text;
    }

    if (stopReason === "cancelled") {
      return CANCELLED_OPERATION_TEXT;
    }

    return "Codex 未返回文本输出";
  }

  private async handlePermissionRequest(params: RequestPermissionRequest) {
    const state = this.sessionStates.get(params.sessionId);
    if (!state) {
      throw new Error(`No conversation found for session=${params.sessionId}`);
    }

    if (state.resetRequested) {
      return {
        outcome: mapPermissionDecisionToAcpOutcome(params.options, {
          outcome: "cancelled",
        }),
      };
    }

    const conversationId = state.conversationId;
    const context = state.activePrompt?.context;
    if (!context) {
      throw new Error(`No active prompt context for permission request in conversation=${conversationId}`);
    }

    state.pendingPermission = {
      requestId: params.toolCall.toolCallId,
      toolTitle: params.toolCall.title ?? undefined,
      toolKind: params.toolCall.kind ?? undefined,
      options: params.options,
    };

    try {
      const decision = await context.requestPermission(
        mapPermissionRequestToSdk(conversationId, params),
      );
      return {
        outcome: mapPermissionDecisionToAcpOutcome(params.options, decision),
      };
    } finally {
      state.pendingPermission = undefined;
    }
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const state = this.sessionStates.get(notification.sessionId);
    if (!state) {
      return;
    }

    const conversationId = state.conversationId;

    if (notification.update.sessionUpdate === "config_option_update") {
      this.updateConversationConfigOptions(
        conversationId,
        state,
        notification.update.configOptions,
        "config_option_update",
      );
      return;
    }

    if (notification.update.sessionUpdate === "usage_update") {
      state.usage = {
        size: notification.update.size,
        used: notification.update.used,
        cost: notification.update.cost ?? undefined,
      };
    }
  }

  private updateConversationConfigOptions(
    conversationId: string,
    state: AcpConversationState,
    configOptions: SessionConfigOption[] | null | undefined,
    source: string,
  ): void {
    state.configOptions = configOptions?.length ? configOptions : undefined;
    const modelOption = findModelConfigOption(state.configOptions);
    const reasoningOption = findReasoningConfigOption(state.configOptions);
    log(
      `config options updated: conversation=${conversationId} source=${source} model=${getConfigValue(modelOption)} reasoning=${getConfigValue(reasoningOption)}`,
    );
  }

  /**
   * Clear/reset the session for a given conversation.
   * The next message will automatically create a fresh session.
   */
  async clearSession(conversationId: string): Promise<void> {
    const state = this.conversations.get(conversationId);
    if (!state) {
      return;
    }

    state.resetRequested = true;
    if (this.conversations.get(conversationId) === state) {
      this.conversations.delete(conversationId);
    }

    const activePrompt = state.activePrompt;
    if (activePrompt) {
      await activePrompt.completion;
    }

    const sessionLabel = state.sessionId || "pending";
    log(`clearing session for conversation=${conversationId} (session=${sessionLabel})`);
    state.pendingPermission = undefined;
    if (state.sessionId) {
      this.connection.unregisterCollector(state.sessionId);
      this.sessionStates.delete(state.sessionId);
    }
  }

  async cancelTurn(conversationId: string): Promise<void> {
    const state = this.conversations.get(conversationId);
    if (!state) {
      return;
    }

    const activePrompt = state.activePrompt;
    if (!activePrompt || !state.sessionId) {
      return;
    }

    const conn = await this.connection.ensureReady();
    await conn.cancel({ sessionId: state.sessionId });
    await activePrompt.completion;
  }

  /**
   * Kill the ACP subprocess and clean up all sessions.
   */
  dispose(): void {
    this.conversations.clear();
    this.sessionStates.clear();
    this.connection.dispose();
  }
}
