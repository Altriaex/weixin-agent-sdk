import type {
  AgentConfigOption,
  AgentConfigOptionValue,
} from "weixin-agent-sdk";
import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";

export type AcpConversationStateSnapshot = {
  sessionId: string;
  activePrompt?: {
    turnId: string;
    startedAt: number;
  };
  pendingPermission?: {
    requestId: string;
    toolTitle?: string;
    toolKind?: string;
  };
  usage?: {
    size: number;
    used: number;
    cost?: {
      amount: number;
      currency: string;
    } | null;
  };
  configOptions?: SessionConfigOption[];
};

export type CodexStatusSummaryInput = {
  sessionId: string;
  model?: string;
  reasoningEffort?: string;
  summaryMode?: string;
  cwd?: string;
  permissions?: string;
  account?: string;
  contextWindow?: string;
  fiveHourLimit?: string;
  weeklyLimit?: string;
};

const MODEL_CONFIG_KEYS = new Set(["model"]);
const REASONING_CONFIG_KEYS = new Set(["thought_level", "reasoning", "reasoning_effort"]);
export const SDK_MODEL_CONFIG_ID = "model";
export const SDK_REASONING_CONFIG_ID = "reasoning_effort";

function normalizeConfigKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function isSelectGroup(
  option: SessionConfigSelectOption | SessionConfigSelectGroup,
): option is SessionConfigSelectGroup {
  return "group" in option;
}

function flattenSelectOptions(
  options: Extract<SessionConfigOption, { type: "select" }>["options"],
): AgentConfigOptionValue[] {
  const values: AgentConfigOptionValue[] = [];

  for (const option of options) {
    if (isSelectGroup(option)) {
      values.push(
        ...option.options.map((groupedOption) => ({
          value: groupedOption.value,
          label: groupedOption.name,
          description: groupedOption.description ?? undefined,
        })),
      );
      continue;
    }

    values.push({
      value: option.value,
      label: option.name,
      description: option.description ?? undefined,
    });
  }

  return values;
}

function matchesConfigOption(
  option: SessionConfigOption,
  candidateKeys: ReadonlySet<string>,
): boolean {
  return (
    candidateKeys.has(normalizeConfigKey(option.id)) ||
    candidateKeys.has(normalizeConfigKey(option.name)) ||
    candidateKeys.has(normalizeConfigKey(option.category))
  );
}

function getCurrentValue(option: SessionConfigOption): string {
  return option.type === "boolean" ? String(option.currentValue) : option.currentValue;
}

function describePendingPermission(
  pendingPermission: AcpConversationStateSnapshot["pendingPermission"],
): string {
  if (!pendingPermission) {
    return "none";
  }

  const detail = pendingPermission.toolTitle ?? pendingPermission.toolKind ?? pendingPermission.requestId;
  return detail.trim() ? detail : "pending";
}

function describeContextUsage(usage: AcpConversationStateSnapshot["usage"]): string {
  if (!usage) {
    return "unavailable";
  }

  const remaining = Math.max(usage.size - usage.used, 0);
  const percentLeft =
    usage.size > 0 ? Math.max(0, Math.min(100, Math.round((remaining / usage.size) * 100))) : 0;

  return `${percentLeft}% left (${usage.used} / ${usage.size} used)`;
}

function formatCompactTokenCount(value: number): string {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}K`;
  }
  return String(value);
}

function formatStatusLine(label: string, value: string): string {
  return `${label.padEnd(22, " ")}${value}`;
}

export function mapAcpConfigOptionToSdk(
  option: SessionConfigOption,
  sdkConfigId = option.id,
): AgentConfigOption {
  if (option.type === "boolean") {
    return {
      id: sdkConfigId,
      label: option.name,
      description: option.description ?? undefined,
      value: String(option.currentValue),
      options: [
        { value: "true", label: "true" },
        { value: "false", label: "false" },
      ],
    };
  }

  return {
    id: sdkConfigId,
    label: option.name,
    description: option.description ?? undefined,
    value: option.currentValue,
    options: flattenSelectOptions(option.options),
  };
}

export function findModelConfigOption(
  configOptions: SessionConfigOption[] | undefined,
): SessionConfigOption | undefined {
  return configOptions?.find((option) => matchesConfigOption(option, MODEL_CONFIG_KEYS));
}

export function findReasoningConfigOption(
  configOptions: SessionConfigOption[] | undefined,
): SessionConfigOption | undefined {
  return configOptions?.find((option) => matchesConfigOption(option, REASONING_CONFIG_KEYS));
}

export function getSdkConversationConfigOptions(
  configOptions: SessionConfigOption[] | undefined,
): AgentConfigOption[] {
  const options: AgentConfigOption[] = [];
  const modelOption = findModelConfigOption(configOptions);
  const reasoningOption = findReasoningConfigOption(configOptions);

  if (modelOption) {
    options.push(mapAcpConfigOptionToSdk(modelOption, SDK_MODEL_CONFIG_ID));
  }
  if (reasoningOption) {
    options.push(mapAcpConfigOptionToSdk(reasoningOption, SDK_REASONING_CONFIG_ID));
  }

  return options;
}

export function resolveAcpConfigOption(
  configOptions: SessionConfigOption[] | undefined,
  configId: string,
): SessionConfigOption | undefined {
  const normalizedId = normalizeConfigKey(configId);
  if (MODEL_CONFIG_KEYS.has(normalizedId)) {
    return findModelConfigOption(configOptions);
  }
  if (REASONING_CONFIG_KEYS.has(normalizedId)) {
    return findReasoningConfigOption(configOptions);
  }
  return configOptions?.find((option) => normalizeConfigKey(option.id) === normalizedId);
}

export function buildNativeModelUpdateCommand(
  configId: string,
  value: string,
): string | undefined {
  if (normalizeConfigKey(configId) !== SDK_MODEL_CONFIG_ID) {
    return undefined;
  }
  return `/model ${value}`.trim();
}

export function formatCodexContextWindow(
  usage: AcpConversationStateSnapshot["usage"],
  fallbackSize?: number,
): string {
  if (!usage) {
    if (typeof fallbackSize === "number" && fallbackSize > 0) {
      return `100% left (0 used / ${formatCompactTokenCount(fallbackSize)})`;
    }
    return "unavailable";
  }

  const remaining = Math.max(usage.size - usage.used, 0);
  const percentLeft =
    usage.size > 0 ? Math.max(0, Math.min(100, Math.round((remaining / usage.size) * 100))) : 0;

  return `${percentLeft}% left (${formatCompactTokenCount(usage.used)} used / ${formatCompactTokenCount(usage.size)})`;
}

export function buildCodexStatusSummary(input: CodexStatusSummaryInput): string {
  const modelDetails = [
    input.reasoningEffort ? `reasoning ${input.reasoningEffort}` : undefined,
    input.summaryMode ? `summaries ${input.summaryMode}` : undefined,
  ].filter((value): value is string => Boolean(value));

  const model =
    input.model && modelDetails.length > 0
      ? `${input.model} (${modelDetails.join(", ")})`
      : (input.model ?? "unknown");

  return [
    formatStatusLine("Session:", input.sessionId),
    formatStatusLine("Model:", model),
    formatStatusLine("Directory:", input.cwd ?? "unavailable"),
    formatStatusLine("Permissions:", input.permissions ?? "unavailable"),
    formatStatusLine("Account:", input.account ?? "unavailable"),
    formatStatusLine("Context Window:", input.contextWindow ?? "unavailable"),
    formatStatusLine("5h Limit:", input.fiveHourLimit ?? "unavailable"),
    formatStatusLine("Weekly Limit:", input.weeklyLimit ?? "unavailable"),
  ].join("\n");
}

export function buildLocalStatusSummary(state: AcpConversationStateSnapshot): string {
  const modelOption = findModelConfigOption(state.configOptions);
  const reasoningOption = findReasoningConfigOption(state.configOptions);
  const cost = state.usage?.cost;
  const lines = [
    "本地摘要",
    `session: active (${state.sessionId})`,
    `model: ${modelOption ? getCurrentValue(modelOption) : "unknown"}`,
    `reasoning: ${reasoningOption ? getCurrentValue(reasoningOption) : "unknown"}`,
    `context: ${describeContextUsage(state.usage)}`,
    `active_prompt: ${state.activePrompt ? "running" : "idle"}`,
    `pending_permission: ${describePendingPermission(state.pendingPermission)}`,
  ];

  if (cost) {
    lines.push(`cost: ${cost.amount} ${cost.currency}`);
  }

  return lines.join("\n");
}
