import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  Agent,
  AgentConfigOption,
  AgentConfigOptionsResult,
  ChatContext,
  ChatRequest,
} from "../agent/interface.js";
import { sendTyping } from "../api/api.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { getExtensionFromMime } from "../media/mime.js";
import { logger } from "../util/logger.js";

import { setContextToken, bodyFromItemList, isMediaItem } from "./inbound.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { markdownToPlainText, sendMessageWeixin } from "./send.js";
import {
  handleSlashCommand,
  isControlSlashCommand,
} from "./slash-commands.js";
import type { createConversationDispatcher } from "../monitor/conversation-dispatcher.js";

const MEDIA_TEMP_DIR = "/tmp/weixin-agent/media";
const MODEL_CONFIG_IDS = new Set(["model"]);
const REASONING_CONFIG_IDS = new Set(["thought_level", "reasoning", "reasoning_effort"]);
const CANCELLED_OPERATION_TEXT = "当前操作已取消";
const TYPING_STATUS = {
  TYPING: 1,
  CANCEL: 2,
} as const;

/** Save a buffer to a temporary file, returning the file path. */
async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  _maxBytes?: number,
  originalFilename?: string,
): Promise<{ path: string }> {
  const dir = path.join(MEDIA_TEMP_DIR, subdir ?? "");
  await fs.mkdir(dir, { recursive: true });
  let ext = ".bin";
  if (originalFilename) {
    ext = path.extname(originalFilename) || ".bin";
  } else if (contentType) {
    ext = getExtensionFromMime(contentType);
  }
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);
  return { path: filePath };
}

/** Dependencies for processOneMessage. */
export type ProcessMessageDeps = {
  accountId: string;
  agent: Agent;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  typingTicket?: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  conversationController?: Pick<
    ReturnType<typeof createConversationDispatcher>,
    | "getConversationResetVersion"
    | "requestPermission"
    | "isPendingPermission"
    | "getPendingPermissionNoticeAbortSignal"
    | "approvePendingPermission"
    | "rejectPendingPermission"
    | "clearPendingPermission"
    | "attachTypingIndicator"
    | "cancelActiveTyping"
  >;
  conversationResetVersion?: number;
};

/** Extract raw text from item_list (for slash command detection). */
function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

function normalizeConfigId(configId: string): string {
  return configId.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function findConfigOption(
  options: AgentConfigOption[],
  candidateIds: ReadonlySet<string>,
): AgentConfigOption | undefined {
  return options.find((option) => candidateIds.has(normalizeConfigId(option.id)));
}

function formatConfigChoices(option?: AgentConfigOption): string | undefined {
  if (!option?.options?.length) {
    return undefined;
  }
  return option.options.map((item) => item.value).join(", ");
}

function formatModelConfig(result: AgentConfigOptionsResult): string {
  const modelOption = findConfigOption(result.options, MODEL_CONFIG_IDS);
  const reasoningOption = findConfigOption(result.options, REASONING_CONFIG_IDS);
  const lines: string[] = [];

  if (result.text?.trim()) {
    lines.push(result.text.trim());
  }

  if (modelOption || reasoningOption) {
    lines.push("当前配置");
    if (modelOption) {
      lines.push(`model: ${modelOption.value ?? "未设置"}`);
    }
    if (reasoningOption) {
      lines.push(`reasoning: ${reasoningOption.value ?? "未设置"}`);
    }
  }

  const modelChoices = formatConfigChoices(modelOption);
  const reasoningChoices = formatConfigChoices(reasoningOption);
  if (modelChoices || reasoningChoices) {
    lines.push("可选项");
    if (modelChoices) {
      lines.push(`model: ${modelChoices}`);
    }
    if (reasoningChoices) {
      lines.push(`reasoning: ${reasoningChoices}`);
    }
  }

  return lines.join("\n").trim() || "当前 Agent 不支持 /model";
}

function isAllowedConfigValue(option: AgentConfigOption, value: string): boolean {
  if (!option.options?.length) {
    return true;
  }
  return option.options.some((item) => item.value === value);
}

function formatInvalidConfigValueMessage(
  result: AgentConfigOptionsResult,
  fieldName: "model" | "reasoning",
  value: string,
): string {
  const detail = formatModelConfig(result);
  return [`无效的 ${fieldName}: ${value}`, detail].join("\n\n");
}

function formatPermissionPrompt(input: Parameters<ChatContext["requestPermission"]>[0]): string {
  const lines = ["Codex 请求执行操作"];
  if (input.title?.trim()) {
    lines.push(`tool: ${input.title.trim()}`);
  }
  if (input.kind?.trim()) {
    lines.push(`kind: ${input.kind.trim()}`);
  }
  lines.push("");
  lines.push("回复 /approve 允许，或回复 /reject 拒绝。");
  return lines.join("\n");
}

function createTypingIndicatorController(
  sendStatus: (status: number) => Promise<void>,
) {
  let stopped = false;
  let tail = Promise.resolve();

  function enqueue(status: number): Promise<void> {
    if (stopped && status !== TYPING_STATUS.CANCEL) {
      return Promise.resolve();
    }

    const next = tail
      .catch(() => {})
      .then(() => sendStatus(status));
    tail = next;
    return next.catch(() => {});
  }

  return {
    sendTyping(): Promise<void> {
      return enqueue(TYPING_STATUS.TYPING);
    },
    async stop(): Promise<void> {
      if (stopped) {
        return tail.catch(() => {});
      }
      stopped = true;
      return enqueue(TYPING_STATUS.CANCEL);
    },
  };
}

type PermissionController = Pick<
  NonNullable<ProcessMessageDeps["conversationController"]>,
  | "requestPermission"
  | "isPendingPermission"
  | "getPendingPermissionNoticeAbortSignal"
  | "clearPendingPermission"
>;

async function requestPermissionWithNotice(input: {
  conversationId: string;
  request: Parameters<ChatContext["requestPermission"]>[0];
  controller: PermissionController;
  sendNotice: (abortSignal?: AbortSignal) => Promise<void>;
}): Promise<Awaited<ReturnType<ChatContext["requestPermission"]>>> {
  const decisionPromise = input.controller.requestPermission(input.conversationId, input.request);
  const requestId = input.request.requestId;

  if (!input.controller.isPendingPermission(input.conversationId, requestId)) {
    return decisionPromise;
  }

  try {
    await input.sendNotice(
      input.controller.getPendingPermissionNoticeAbortSignal(
        input.conversationId,
        requestId,
      ),
    );
    if (!input.controller.isPendingPermission(input.conversationId, requestId)) {
      return decisionPromise;
    }
  } catch {
    input.controller.clearPendingPermission(input.conversationId);
    return decisionPromise;
  }

  return decisionPromise;
}

type ResetConversationController = Pick<
  NonNullable<ProcessMessageDeps["conversationController"]>,
  "cancelActiveTyping" | "clearPendingPermission"
>;

async function resetConversation(
  agent: Pick<Agent, "cancelTurn" | "clearSession">,
  conversationId: string,
  conversationController?: ResetConversationController,
): Promise<void> {
  await conversationController?.cancelActiveTyping?.(conversationId);
  conversationController?.clearPendingPermission?.(conversationId);
  await agent.cancelTurn?.(conversationId);
  await agent.clearSession?.(conversationId);
}

async function sendTypingCancel(
  deps: ProcessMessageDeps,
  conversationId: string,
  reason: string,
): Promise<void> {
  if (!deps.typingTicket) {
    return;
  }

  logger.debug(
    `[weixin] sendTyping cancel: conversation=${conversationId} reason=${reason} status=${TypingStatus.CANCEL}`,
  );
  await sendTyping({
    baseUrl: deps.baseUrl,
    token: deps.token,
    body: {
      ilink_user_id: conversationId,
      typing_ticket: deps.typingTicket,
      status: TypingStatus.CANCEL,
    },
  }).catch(() => {});
}

async function getStatusReply(agent: Agent, conversationId: string): Promise<string> {
  if (!agent.getStatus) {
    return "当前 Agent 不支持 /status";
  }
  const status = await agent.getStatus(conversationId);
  return status.text.trim() || "当前 Agent 未返回状态信息";
}

async function getModelReply(agent: Agent, conversationId: string, args: string): Promise<string> {
  if (!agent.getConfigOptions) {
    return "当前 Agent 不支持 /model";
  }

  const config = await agent.getConfigOptions(conversationId);
  if (config.text?.trim() === CANCELLED_OPERATION_TEXT && config.options.length === 0) {
    return CANCELLED_OPERATION_TEXT;
  }
  const values = args.trim() ? args.trim().split(/\s+/) : [];
  const rawArgs = args.trim();
  if (values.length === 0) {
    return formatModelConfig(config);
  }
  if (values.length > 2) {
    return "用法: /model <model> [reasoning]";
  }
  if (!agent.setConfigOption) {
    return "当前 Agent 不支持 /model";
  }

  const [modelValue, reasoningValue] = values;
  const modelOption = findConfigOption(config.options, MODEL_CONFIG_IDS);
  if (!modelOption) {
    if (config.options.length === 0) {
      const result = await agent.setConfigOption(conversationId, "model", rawArgs);
      if (result.text?.trim() === CANCELLED_OPERATION_TEXT) {
        return CANCELLED_OPERATION_TEXT;
      }
      return result.text?.trim() || formatModelConfig(config);
    }
    return formatModelConfig(config);
  }
  if (!isAllowedConfigValue(modelOption, modelValue)) {
    return formatInvalidConfigValueMessage(config, "model", modelValue);
  }

  const reasoningOption = findConfigOption(config.options, REASONING_CONFIG_IDS);
  if (reasoningValue) {
    if (!reasoningOption) {
      return "当前 Agent 不支持设置 reasoning";
    }
    if (!isAllowedConfigValue(reasoningOption, reasoningValue)) {
      return formatInvalidConfigValueMessage(config, "reasoning", reasoningValue);
    }
  }

  const modelUpdateResult = await agent.setConfigOption(conversationId, modelOption.id, modelValue);
  if (modelUpdateResult.text?.trim() === CANCELLED_OPERATION_TEXT) {
    return CANCELLED_OPERATION_TEXT;
  }
  if (reasoningValue && reasoningOption) {
    const result = await agent.setConfigOption(conversationId, reasoningOption.id, reasoningValue);
    if (result.text?.trim() === CANCELLED_OPERATION_TEXT) {
      return CANCELLED_OPERATION_TEXT;
    }
  }

  const updatedConfig = await agent.getConfigOptions(conversationId);
  if (updatedConfig.text?.trim() === CANCELLED_OPERATION_TEXT && updatedConfig.options.length === 0) {
    return CANCELLED_OPERATION_TEXT;
  }
  return ["已更新当前配置", formatModelConfig(updatedConfig)].join("\n");
}

function createChatContext(
  conversationId: string,
  deps: ProcessMessageDeps,
  contextToken: string | undefined,
): ChatContext {
  return {
    async requestPermission(input) {
      if (!deps.conversationController) {
        throw new Error(
          `Permission requests are not available yet for conversation ${conversationId} (request ${input.requestId})`,
        );
      }

      return requestPermissionWithNotice({
        conversationId,
        request: input,
        controller: deps.conversationController,
        sendNotice: (abortSignal) =>
          sendMessageWeixin({
            to: conversationId,
            text: formatPermissionPrompt(input),
            opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, abortSignal },
          }).then(() => undefined),
      });
    },
  };
}

function isConversationTurnStale(
  conversationId: string,
  deps: ProcessMessageDeps,
): boolean {
  if (
    !deps.conversationController ||
    typeof deps.conversationResetVersion !== "number"
  ) {
    return false;
  }

  return (
    deps.conversationController.getConversationResetVersion(conversationId) !==
    deps.conversationResetVersion
  );
}

/** Find the first downloadable media item from a message. */
function findMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
  if (!itemList?.length) return undefined;

  const hasDownloadableMedia = (m?: { encrypt_query_param?: string; full_url?: string }) =>
    m?.encrypt_query_param || m?.full_url;

  // Direct media: IMAGE > VIDEO > FILE > VOICE (skip voice with transcription)
  const direct =
    itemList.find(
      (i) => i.type === MessageItemType.IMAGE && hasDownloadableMedia(i.image_item?.media),
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.VIDEO && hasDownloadableMedia(i.video_item?.media),
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.FILE && hasDownloadableMedia(i.file_item?.media),
    ) ??
    itemList.find(
      (i) =>
        i.type === MessageItemType.VOICE &&
        hasDownloadableMedia(i.voice_item?.media) &&
        !i.voice_item?.text,
    );
  if (direct) return direct;

  // Quoted media: check ref_msg
  const refItem = itemList.find(
    (i) =>
      i.type === MessageItemType.TEXT &&
      i.ref_msg?.message_item &&
      isMediaItem(i.ref_msg.message_item),
  );
  return refItem?.ref_msg?.message_item ?? undefined;
}

/**
 * Process a single inbound message:
 *   slash command check → download media → call agent → send reply.
 */
export async function processOneMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<void> {
  const receivedAt = Date.now();
  const textBody = extractTextBody(full.item_list);
  const conversationId = full.from_user_id ?? "";
  const isControlSlash = isControlSlashCommand(textBody);

  if (!isControlSlash && isConversationTurnStale(conversationId, deps)) {
    logger.info(`[weixin] drop stale turn before processing conversation=${conversationId}`);
    return;
  }

  // --- Slash commands ---
  if (textBody.startsWith("/")) {
    const slashResult = await handleSlashCommand(
      textBody,
      {
        to: conversationId,
        contextToken: full.context_token,
        baseUrl: deps.baseUrl,
        token: deps.token,
        accountId: deps.accountId,
        log: deps.log,
        errLog: deps.errLog,
        shouldSendReply: () => !isConversationTurnStale(conversationId, deps),
        onClear: async () => {
          await sendTypingCancel(deps, conversationId, "slash-clear:pre-reset");
          await resetConversation(deps.agent, conversationId, deps.conversationController);
          return "✅ 会话已清除，重新开始对话";
        },
        onNew: async () => {
          await sendTypingCancel(deps, conversationId, "slash-new:pre-reset");
          await resetConversation(deps.agent, conversationId, deps.conversationController);
          return "✅ 已切换到新会话";
        },
        onStatus: deps.agent.getStatus
          ? () => getStatusReply(deps.agent, conversationId)
          : undefined,
        onModel: deps.agent.getConfigOptions
          ? (args) => getModelReply(deps.agent, conversationId, args)
          : undefined,
        onApprove: () => {
          const result = deps.conversationController?.approvePendingPermission(conversationId);
          if (result === "resolved") {
            return "已批准当前待审批操作";
          }
          if (result === "unsupported") {
            return "当前待审批操作不支持 /approve，v1 仅支持单次批准";
          }
          return "当前没有待审批操作";
        },
        onReject: () => {
          const result = deps.conversationController?.rejectPendingPermission(conversationId);
          if (result === "resolved") {
            return "已拒绝当前待审批操作";
          }
          if (result === "unsupported") {
            return "当前待审批操作不支持 /reject，v1 仅支持单次拒绝";
          }
          return "当前没有待审批操作";
        },
      },
      receivedAt,
      full.create_time_ms,
    );
    if (slashResult.handled) return;
  }

  if (isConversationTurnStale(conversationId, deps)) {
    logger.info(`[weixin] drop stale turn before processing conversation=${conversationId}`);
    return;
  }

  // --- Store context token ---
  const contextToken = full.context_token;
  if (contextToken) {
    setContextToken(deps.accountId, conversationId, contextToken);
  }

  // --- Download media ---
  let media: ChatRequest["media"];
  const mediaItem = findMediaItem(full.item_list);
  if (mediaItem) {
    try {
      const downloaded = await downloadMediaFromItem(mediaItem, {
        cdnBaseUrl: deps.cdnBaseUrl,
        saveMedia: saveMediaBuffer,
        log: deps.log,
        errLog: deps.errLog,
        label: "inbound",
      });
      if (downloaded.decryptedPicPath) {
        media = { type: "image", filePath: downloaded.decryptedPicPath, mimeType: "image/*" };
      } else if (downloaded.decryptedVideoPath) {
        media = { type: "video", filePath: downloaded.decryptedVideoPath, mimeType: "video/mp4" };
      } else if (downloaded.decryptedFilePath) {
        media = {
          type: "file",
          filePath: downloaded.decryptedFilePath,
          mimeType: downloaded.fileMediaType ?? "application/octet-stream",
        };
      } else if (downloaded.decryptedVoicePath) {
        media = {
          type: "audio",
          filePath: downloaded.decryptedVoicePath,
          mimeType: downloaded.voiceMediaType ?? "audio/wav",
        };
      }
    } catch (err) {
      logger.error(`media download failed: ${String(err)}`);
    }
  }

  // --- Build ChatRequest ---
  const request: ChatRequest = {
    conversationId: conversationId,
    text: bodyFromItemList(full.item_list),
    media,
  };

  if (isConversationTurnStale(conversationId, deps)) {
    logger.info(`[weixin] drop stale turn after preparing request conversation=${conversationId}`);
    return;
  }

  // --- Typing indicator (start + periodic refresh) ---
  const to = full.from_user_id ?? "";
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let typingController:
    | ReturnType<typeof createTypingIndicatorController>
    | undefined;
  let releaseTypingIndicator: (() => void) | undefined;
  let typingStopped = false;
  const sendTypingStatus = async (status: number) => {
    if (!deps.typingTicket) {
      return;
    }
    logger.debug(
      `[weixin] sendTyping status: conversation=${to} status=${status}`,
    );
    await sendTyping({
      baseUrl: deps.baseUrl,
      token: deps.token,
      body: {
        ilink_user_id: to,
        typing_ticket: deps.typingTicket,
        status,
      },
    }).catch(() => {});
  };
  const startTyping = () => {
    if (!typingController || typingStopped) {
      return;
    }
    void typingController.sendTyping();
  };
  const stopTyping = async () => {
    if (typingStopped) {
      return;
    }
    typingStopped = true;
    releaseTypingIndicator?.();
    releaseTypingIndicator = undefined;
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
    if (!typingController) {
      return;
    }
    await typingController.stop();
  };
  if (deps.typingTicket) {
    typingController = createTypingIndicatorController(sendTypingStatus);
    releaseTypingIndicator = deps.conversationController?.attachTypingIndicator(
      request.conversationId,
      stopTyping,
    );
    startTyping();
    typingTimer = setInterval(startTyping, 10_000);
  }

  // --- Call agent & send reply ---
  try {
    if (isConversationTurnStale(conversationId, deps)) {
      logger.info(`[weixin] drop stale turn before agent.chat conversation=${conversationId}`);
      return;
    }

    const response = await deps.agent.chat(
      request,
      createChatContext(request.conversationId, deps, contextToken),
    );

    if (isConversationTurnStale(conversationId, deps)) {
      logger.info(`[weixin] drop stale turn after agent.chat conversation=${conversationId}`);
      return;
    }

    if (response.media) {
      let filePath: string;
      const mediaUrl = response.media.url;
      if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
        filePath = await downloadRemoteImageToTemp(
          mediaUrl,
          path.join(MEDIA_TEMP_DIR, "outbound"),
        );
      } else {
        filePath = path.isAbsolute(mediaUrl) ? mediaUrl : path.resolve(mediaUrl);
      }
      if (isConversationTurnStale(conversationId, deps)) {
        logger.info(`[weixin] drop stale media reply conversation=${conversationId}`);
        return;
      }
      await sendWeixinMediaFile({
        filePath,
        to,
        text: response.text ? markdownToPlainText(response.text) : "",
        opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
        cdnBaseUrl: deps.cdnBaseUrl,
      });
    } else if (response.text) {
      if (isConversationTurnStale(conversationId, deps)) {
        logger.info(`[weixin] drop stale text reply conversation=${conversationId}`);
        return;
      }
      await sendMessageWeixin({
        to,
        text: markdownToPlainText(response.text),
        opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
      });
    }
  } catch (err) {
    logger.error(`processOneMessage: agent or send failed: ${err instanceof Error ? err.stack ?? err.message : JSON.stringify(err)}`);
    if (isConversationTurnStale(conversationId, deps)) {
      logger.info(`[weixin] drop stale error notice conversation=${conversationId}`);
      return;
    }
    void sendWeixinErrorNotice({
      to,
      contextToken,
      message: `⚠️ 处理消息失败：${err instanceof Error ? err.message : JSON.stringify(err)}`,
      baseUrl: deps.baseUrl,
      token: deps.token,
      errLog: deps.errLog,
    });
  } finally {
    // --- Typing indicator (cancel) ---
    await stopTyping();
  }
}
