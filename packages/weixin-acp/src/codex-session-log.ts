import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type CodexRateLimitWindow = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
};

export type CodexRateLimits = {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  planType?: string;
};

export type CodexSessionMetadata = {
  cwd?: string;
  approvalPolicy?: string;
  sandboxType?: string;
  model?: string;
  reasoningEffort?: string;
  summaryMode?: string;
  contextWindowSize?: number;
};

export type CodexAccountProfile = {
  email?: string;
  planType?: string;
};

export type CodexCliConfig = {
  model?: string;
  reasoningEffort?: string;
  summaryMode?: string;
};

export type CodexStatusArtifacts = {
  exactSessionLogPath?: string;
  rateLimitSessionLogPath?: string;
  sessionMetadata?: CodexSessionMetadata;
  rateLimits?: CodexRateLimits;
  accountProfile?: CodexAccountProfile;
  cliConfig?: CodexCliConfig;
};

type TokenCountEvent = {
  type: "event_msg";
  payload?: {
    type?: string;
    rate_limits?: {
      primary?: {
        used_percent?: number;
        window_minutes?: number;
        resets_at?: number;
      } | null;
      secondary?: {
        used_percent?: number;
        window_minutes?: number;
        resets_at?: number;
      } | null;
      plan_type?: string | null;
    } | null;
  };
};

type TurnContextEvent = {
  type: "turn_context";
  payload?: {
    cwd?: string;
    approval_policy?: string;
    sandbox_policy?:
      | {
          type?: string;
        }
      | string;
    model?: string;
    effort?: string;
    reasoning_effort?: string;
    summary?: string;
    collaboration_mode?: {
      settings?: {
        reasoning_effort?: string;
      };
    };
  };
};

type TaskStartedEvent = {
  type: "event_msg";
  payload?: {
    type?: string;
    model_context_window?: number;
    info?: {
      model_context_window?: number;
    } | null;
  };
};

type SessionMetaEvent = {
  type: "session_meta";
  payload?: {
    cwd?: string;
  };
};

type AuthFile = {
  tokens?: {
    id_token?: string | null;
  };
};

function getCodexHomeDir(codexHome?: string): string {
  return codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function formatDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatResetAt(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return [
    `${date.getFullYear()}-${formatDatePart(date.getMonth() + 1)}-${formatDatePart(date.getDate())}`,
    `${formatDatePart(date.getHours())}:${formatDatePart(date.getMinutes())}`,
  ].join(" ");
}

function formatQuotaLabel(windowMinutes: number): string {
  if (windowMinutes % 1440 === 0) {
    return `${windowMinutes / 1440}d quota`;
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h quota`;
  }
  return `${windowMinutes}m quota`;
}

function normalizeWindow(
  value:
    | {
        used_percent?: number;
        window_minutes?: number;
        resets_at?: number;
      }
    | null
    | undefined,
): CodexRateLimitWindow | undefined {
  if (
    !value ||
    typeof value.used_percent !== "number" ||
    typeof value.window_minutes !== "number" ||
    typeof value.resets_at !== "number"
  ) {
    return undefined;
  }

  return {
    usedPercent: value.used_percent,
    windowMinutes: value.window_minutes,
    resetsAt: value.resets_at,
  };
}

function mergeSessionMetadata(
  target: CodexSessionMetadata,
  source: CodexSessionMetadata | undefined,
): void {
  if (!source) {
    return;
  }

  target.cwd ??= source.cwd;
  target.approvalPolicy ??= source.approvalPolicy;
  target.sandboxType ??= source.sandboxType;
  target.model ??= source.model;
  target.reasoningEffort ??= source.reasoningEffort;
  target.summaryMode ??= source.summaryMode;
  target.contextWindowSize ??= source.contextWindowSize;
}

async function readFileSegment(
  handle: fs.FileHandle,
  position: number,
  size: number,
): Promise<string> {
  const buffer = Buffer.alloc(size);
  await handle.read(buffer, 0, size, position);
  return buffer.toString("utf8");
}

function getSummaryMode(config: CodexCliConfig | undefined, metadata: CodexSessionMetadata | undefined): string {
  return metadata?.summaryMode ?? config?.summaryMode ?? "auto";
}

export function parseCodexSessionMetadataFromLine(line: string): CodexSessionMetadata | undefined {
  if (!line.trim()) {
    return undefined;
  }

  let parsed: TurnContextEvent | SessionMetaEvent | TaskStartedEvent;
  try {
    parsed = JSON.parse(line) as TurnContextEvent | SessionMetaEvent | TaskStartedEvent;
  } catch {
    return undefined;
  }

  if (parsed.type === "session_meta") {
    return parsed.payload?.cwd ? { cwd: parsed.payload.cwd } : undefined;
  }

  if (parsed.type === "event_msg") {
    const contextWindowSize =
      parsed.payload?.type === "task_started"
        ? parsed.payload.model_context_window
        : parsed.payload?.type === "token_count"
          ? parsed.payload.info?.model_context_window
          : undefined;

    if (typeof contextWindowSize === "number") {
      return { contextWindowSize };
    }

    return undefined;
  }

  if (parsed.type !== "turn_context" || !parsed.payload) {
    return undefined;
  }

  const sandboxPolicy = parsed.payload.sandbox_policy;
  const sandboxType =
    typeof sandboxPolicy === "string"
      ? sandboxPolicy
      : sandboxPolicy?.type;
  const reasoningEffort =
    parsed.payload.reasoning_effort ??
    parsed.payload.effort ??
    parsed.payload.collaboration_mode?.settings?.reasoning_effort;

  const metadata: CodexSessionMetadata = {
    cwd: parsed.payload.cwd,
    approvalPolicy: parsed.payload.approval_policy,
    sandboxType,
    model: parsed.payload.model,
    reasoningEffort,
    summaryMode: parsed.payload.summary,
    contextWindowSize: undefined,
  };

  if (
    !metadata.cwd &&
    !metadata.approvalPolicy &&
    !metadata.sandboxType &&
    !metadata.model &&
    !metadata.reasoningEffort &&
    !metadata.summaryMode &&
    typeof metadata.contextWindowSize !== "number"
  ) {
    return undefined;
  }

  return metadata;
}

export function parseCodexRateLimitsFromLine(line: string): CodexRateLimits | undefined {
  if (!line.trim()) {
    return undefined;
  }

  let parsed: TokenCountEvent;
  try {
    parsed = JSON.parse(line) as TokenCountEvent;
  } catch {
    return undefined;
  }

  if (parsed.type !== "event_msg" || parsed.payload?.type !== "token_count" || !parsed.payload.rate_limits) {
    return undefined;
  }

  const primary = normalizeWindow(parsed.payload.rate_limits.primary);
  const secondary = normalizeWindow(parsed.payload.rate_limits.secondary);
  const planType = parsed.payload.rate_limits.plan_type ?? undefined;

  if (!primary && !secondary && !planType) {
    return undefined;
  }

  const rateLimits: CodexRateLimits = {};
  if (primary) {
    rateLimits.primary = primary;
  }
  if (secondary) {
    rateLimits.secondary = secondary;
  }
  if (planType) {
    rateLimits.planType = planType;
  }
  return rateLimits;
}

export function formatCodexRateLimitWindow(window: CodexRateLimitWindow | undefined): string {
  if (!window) {
    return "unavailable";
  }

  const remaining = Math.max(0, 100 - window.usedPercent);
  return `${remaining}% left (used ${window.usedPercent}%, resets ${formatResetAt(window.resetsAt)})`;
}

export function formatCodexRateLimitsSummary(rateLimits: CodexRateLimits): string {
  const lines = ["Codex quota"];

  if (rateLimits.primary) {
    lines.push(
      `${formatQuotaLabel(rateLimits.primary.windowMinutes)}: ${formatCodexRateLimitWindow(rateLimits.primary)}`,
    );
  }

  if (rateLimits.secondary) {
    lines.push(
      `${formatQuotaLabel(rateLimits.secondary.windowMinutes)}: ${formatCodexRateLimitWindow(rateLimits.secondary)}`,
    );
  }

  if (rateLimits.planType) {
    lines.push(`plan: ${rateLimits.planType}`);
  }

  return lines.join("\n");
}

export async function findCodexSessionLogPath(
  sessionId: string,
  createdAt: number,
  codexHome?: string,
): Promise<string | undefined> {
  const date = new Date(createdAt);
  const sessionsDir = path.join(
    getCodexHomeDir(codexHome),
    "sessions",
    String(date.getFullYear()),
    formatDatePart(date.getMonth() + 1),
    formatDatePart(date.getDate()),
  );

  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const match = entries.find(
    (entry) => entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`),
  );

  if (!match) {
    return undefined;
  }

  return path.join(sessionsDir, match.name);
}

export async function readCodexRateLimitsFromSessionLog(
  filePath: string,
): Promise<CodexRateLimits | undefined> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const readSize = Math.min(stat.size, 128 * 1024);
    if (readSize === 0) {
      return undefined;
    }

    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, stat.size - readSize);
    const text = buffer.toString("utf8");
    const lines = text.trimEnd().split("\n");

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const rateLimits = parseCodexRateLimitsFromLine(lines[index]);
      if (rateLimits) {
        return rateLimits;
      }
    }

    return undefined;
  } finally {
    await handle.close();
  }
}

export async function readCodexSessionMetadataFromSessionLog(
  filePath: string,
): Promise<CodexSessionMetadata | undefined> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size === 0) {
      return undefined;
    }

    const headSize = Math.min(stat.size, 32 * 1024);
    const tailSize = Math.min(stat.size, 256 * 1024);
    const headText = await readFileSegment(handle, 0, headSize);
    const tailText = await readFileSegment(handle, stat.size - tailSize, tailSize);
    const metadata: CodexSessionMetadata = {};

    for (const line of headText.split("\n")) {
      const parsed = parseCodexSessionMetadataFromLine(line);
      if (parsed?.cwd) {
        metadata.cwd ??= parsed.cwd;
      }
    }

    const lines = tailText.trimEnd().split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      mergeSessionMetadata(metadata, parseCodexSessionMetadataFromLine(lines[index]));
    }

    if (
      !metadata.cwd &&
      !metadata.approvalPolicy &&
      !metadata.sandboxType &&
      !metadata.model &&
      !metadata.reasoningEffort &&
      !metadata.summaryMode &&
      typeof metadata.contextWindowSize !== "number"
    ) {
      return undefined;
    }

    return metadata;
  } finally {
    await handle.close();
  }
}

async function listSessionLogFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSessionLogFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

export async function findLatestCodexSessionLogPath(codexHome?: string): Promise<string | undefined> {
  const sessionsDir = path.join(getCodexHomeDir(codexHome), "sessions");
  const files = await listSessionLogFiles(sessionsDir);
  if (files.length === 0) {
    return undefined;
  }

  let latestPath: string | undefined;
  let latestMtime = -1;

  for (const filePath of files) {
    const stat = await fs.stat(filePath).catch(() => undefined);
    if (!stat || stat.mtimeMs <= latestMtime) {
      continue;
    }
    latestMtime = stat.mtimeMs;
    latestPath = filePath;
  }

  return latestPath;
}

export async function readCodexAccountProfile(
  codexHome?: string,
): Promise<CodexAccountProfile | undefined> {
  const authPath = path.join(getCodexHomeDir(codexHome), "auth.json");
  const text = await fs.readFile(authPath, "utf8").catch(() => undefined);
  if (!text) {
    return undefined;
  }

  let parsed: AuthFile;
  try {
    parsed = JSON.parse(text) as AuthFile;
  } catch {
    return undefined;
  }

  const token = parsed.tokens?.id_token;
  if (!token) {
    return undefined;
  }

  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) {
    return undefined;
  }

  let payload: {
    email?: string;
    "https://api.openai.com/auth"?: {
      chatgpt_plan_type?: string;
    };
  };
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as {
      email?: string;
      "https://api.openai.com/auth"?: {
        chatgpt_plan_type?: string;
      };
    };
  } catch {
    return undefined;
  }

  if (!payload.email && !payload["https://api.openai.com/auth"]?.chatgpt_plan_type) {
    return undefined;
  }

  return {
    email: payload.email,
    planType: payload["https://api.openai.com/auth"]?.chatgpt_plan_type,
  };
}

export async function readCodexCliConfig(
  codexHome?: string,
): Promise<CodexCliConfig | undefined> {
  const configPath = path.join(getCodexHomeDir(codexHome), "config.toml");
  const text = await fs.readFile(configPath, "utf8").catch(() => undefined);
  if (!text) {
    return undefined;
  }

  const model = text.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
  const reasoningEffort = text.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1];
  const summaryMode =
    text.match(/^summary\s*=\s*"([^"]+)"/m)?.[1] ??
    text.match(/^model_summary\s*=\s*"([^"]+)"/m)?.[1];

  if (!model && !reasoningEffort && !summaryMode) {
    return undefined;
  }

  return {
    model,
    reasoningEffort,
    summaryMode,
  };
}

export async function getCodexStatusArtifacts(input: {
  sessionId: string;
  createdAt: number;
  sessionLogPath?: string;
  codexHome?: string;
}): Promise<CodexStatusArtifacts> {
  const exactSessionLogPath =
    input.sessionLogPath ??
    (await findCodexSessionLogPath(input.sessionId, input.createdAt, input.codexHome));
  const candidatePaths = exactSessionLogPath ? [exactSessionLogPath] : [];

  let sessionMetadata: CodexSessionMetadata | undefined;
  for (const sessionLogPath of candidatePaths) {
    sessionMetadata = await readCodexSessionMetadataFromSessionLog(sessionLogPath);
    if (sessionMetadata) {
      break;
    }
  }

  let rateLimits: CodexRateLimits | undefined;
  let rateLimitSessionLogPath: string | undefined;
  for (const sessionLogPath of candidatePaths) {
    rateLimits = await readCodexRateLimitsFromSessionLog(sessionLogPath);
    if (rateLimits) {
      rateLimitSessionLogPath = sessionLogPath;
      break;
    }
  }

  const cliConfig = await readCodexCliConfig(input.codexHome);
  if (sessionMetadata) {
    sessionMetadata.summaryMode = getSummaryMode(cliConfig, sessionMetadata);
  }

  return {
    exactSessionLogPath,
    rateLimitSessionLogPath,
    sessionMetadata,
    rateLimits,
    accountProfile: await readCodexAccountProfile(input.codexHome),
    cliConfig,
  };
}

export async function getCodexAccountQuotaSummary(input: {
  sessionId: string;
  createdAt: number;
  sessionLogPath?: string;
  codexHome?: string;
}): Promise<{ summary: string; sessionLogPath?: string } | undefined> {
  const artifacts = await getCodexStatusArtifacts(input);
  if (!artifacts.rateLimits) {
    return undefined;
  }

  return {
    summary: formatCodexRateLimitsSummary(artifacts.rateLimits),
    sessionLogPath: artifacts.rateLimitSessionLogPath ?? artifacts.exactSessionLogPath,
  };
}
