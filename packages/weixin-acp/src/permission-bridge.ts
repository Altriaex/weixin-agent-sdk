import type {
  PermissionDecision,
  PermissionRequest,
} from "weixin-agent-sdk";
import type {
  PermissionOption,
  RequestPermissionOutcome,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";

function getPermissionOptionPriority(option: PermissionOption): number {
  const normalized = `${option.kind} ${option.name}`.toLowerCase().replaceAll("-", "_");
  if (normalized.includes("once") || normalized.includes("one_shot")) {
    return 0;
  }
  if (
    normalized.includes("always") ||
    normalized.includes("remember") ||
    normalized.includes("persist") ||
    normalized.includes("session") ||
    normalized.includes("forever")
  ) {
    return 2;
  }
  return 1;
}

function selectPermissionOption(
  options: PermissionOption[],
  prefix: "allow" | "reject",
): PermissionOption | undefined {
  const matchingOptions = options.filter((option) => option.kind.startsWith(prefix));
  if (matchingOptions.length === 0) {
    return undefined;
  }

  return matchingOptions.reduce((bestOption, option) =>
    getPermissionOptionPriority(option) < getPermissionOptionPriority(bestOption)
      ? option
      : bestOption,
  );
}

function selectOneShotPermissionOption(
  options: PermissionOption[],
  prefix: "allow" | "reject",
): PermissionOption | undefined {
  const option = selectPermissionOption(options, prefix);
  if (!option || getPermissionOptionPriority(option) !== 0) {
    return undefined;
  }
  return option;
}

export function mapPermissionRequestToSdk(
  conversationId: string,
  request: RequestPermissionRequest,
): PermissionRequest {
  return {
    conversationId,
    requestId: request.toolCall.toolCallId,
    title: request.toolCall.title ?? undefined,
    kind: request.toolCall.kind ?? undefined,
    options: request.options.map((option) => ({
      id: option.optionId,
      kind: option.kind,
      name: option.name,
    })),
  };
}

export function mapPermissionDecisionToAcpOutcome(
  options: PermissionOption[],
  decision: PermissionDecision,
): RequestPermissionOutcome {
  if (decision.outcome === "selected") {
    return {
      outcome: "selected",
      optionId: decision.optionId,
    };
  }

  if (decision.outcome === "cancelled") {
    return {
      outcome: "cancelled",
    };
  }

  const rejectOption = selectOneShotPermissionOption(options, "reject");
  if (!rejectOption) {
    throw new Error("ACP permission request did not provide a one-shot reject option");
  }

  return {
    outcome: "selected",
    optionId: rejectOption.optionId,
  };
}
