/**
 * Slash command handling for Weixin conversations.
 *
 * Supported commands:
 * - /echo <message>
 * - /toggle-debug
 * - /clear
 * - /new
 * - /status
 * - /model [model] [reasoning]
 * - /approve
 * - /reject
 */
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";

import { toggleDebugMode } from "./debug-mode.js";
import { sendMessageWeixin } from "./send.js";

const slashCommandFallbacks = {
  "/clear": "✅ 会话已清除，重新开始对话",
  "/new": "✅ 已切换到新会话",
  "/status": "当前 Agent 不支持 /status",
  "/model": "当前 Agent 不支持 /model",
  "/approve": "当前没有待审批操作",
  "/reject": "当前没有待审批操作",
} as const;

const CONTROL_SLASH_COMMANDS = new Set(["/approve", "/clear", "/new", "/reject"]);

export interface SlashCommandResult {
  /** Whether the message was handled as a slash command. */
  handled: boolean;
}

export interface SlashCommandContext {
  to: string;
  contextToken?: string;
  baseUrl: string;
  token?: string;
  accountId: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  shouldSendReply?: () => boolean | Promise<boolean>;
  /** Called when /clear is invoked. */
  onClear?: () => string | void | Promise<string | void>;
  /** Called when /new is invoked. */
  onNew?: () => string | void | Promise<string | void>;
  /** Called when /status is invoked. */
  onStatus?: () => string | void | Promise<string | void>;
  /** Called when /model is invoked. */
  onModel?: (args: string) => string | void | Promise<string | void>;
  /** Called when /approve is invoked. */
  onApprove?: () => string | void | Promise<string | void>;
  /** Called when /reject is invoked. */
  onReject?: () => string | void | Promise<string | void>;
}

export type ParsedSlashCommand = {
  name: string;
  args: string;
};

function getSlashCommandFallbackText(command: string): string | undefined {
  return slashCommandFallbacks[command as keyof typeof slashCommandFallbacks];
}

export function parseSlashCommand(content: string): ParsedSlashCommand | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const spaceIdx = trimmed.indexOf(" ");
  const name = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  return { name, args };
}

export function isControlSlashCommand(content: string): boolean {
  const parsed = parseSlashCommand(content);
  return parsed ? CONTROL_SLASH_COMMANDS.has(parsed.name) : false;
}

export function getSlashCommandPriority(content: string): "control" | "normal" {
  return isControlSlashCommand(content) ? "control" : "normal";
}

/** Send a reply message. */
async function sendReply(ctx: SlashCommandContext, text: string): Promise<void> {
  const shouldSendReply = ctx.shouldSendReply ? await ctx.shouldSendReply() : true;
  if (!shouldSendReply) {
    logger.info(`[weixin] drop slash reply: to=${ctx.to}`);
    return;
  }
  const opts: WeixinApiOptions & { contextToken?: string } = {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    contextToken: ctx.contextToken,
  };
  await sendMessageWeixin({ to: ctx.to, text, opts });
}

/** Handle the /echo command. */
async function handleEcho(
  ctx: SlashCommandContext,
  args: string,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<void> {
  const message = args.trim();
  if (message) {
    await sendReply(ctx, message);
  }
  const eventTs = eventTimestamp ?? 0;
  const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
  const timing = [
    "⏱ 通道耗时",
    `├ 事件时间: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
    `├ 平台→插件: ${platformDelay}`,
    `└ 插件处理: ${Date.now() - receivedAt}ms`,
  ].join("\n");
  await sendReply(ctx, timing);
}

async function handleControlCommand(
  ctx: SlashCommandContext,
  handler: (() => string | void | Promise<string | void>) | undefined,
  fallbackText: string,
): Promise<void> {
  const reply = await handler?.();
  await sendReply(ctx, typeof reply === "string" && reply.trim() ? reply : fallbackText);
}

/**
 * Try to handle a slash command.
 *
 * @returns handled=true means the message was consumed as a command.
 */
export async function handleSlashCommand(
  content: string,
  ctx: SlashCommandContext,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<SlashCommandResult> {
  const parsed = parseSlashCommand(content);
  if (!parsed) {
    return { handled: false };
  }
  const { name: command, args } = parsed;

  logger.info(`[weixin] Slash command: ${command}, args: ${args.slice(0, 50)}`);

  try {
    switch (command) {
      case "/echo":
        await handleEcho(ctx, args, receivedAt, eventTimestamp);
        return { handled: true };
      case "/toggle-debug": {
        const enabled = toggleDebugMode(ctx.accountId);
        await sendReply(
          ctx,
          enabled
            ? "Debug 模式已开启"
            : "Debug 模式已关闭",
        );
        return { handled: true };
      }
      case "/clear": {
        await handleControlCommand(
          ctx,
          ctx.onClear,
          getSlashCommandFallbackText(command) ?? "✅ 会话已清除，重新开始对话",
        );
        return { handled: true };
      }
      case "/new": {
        await handleControlCommand(
          ctx,
          ctx.onNew,
          getSlashCommandFallbackText(command) ?? "✅ 已切换到新会话",
        );
        return { handled: true };
      }
      case "/status": {
        await handleControlCommand(
          ctx,
          ctx.onStatus,
          getSlashCommandFallbackText(command) ?? "当前 Agent 不支持 /status",
        );
        return { handled: true };
      }
      case "/model": {
        await handleControlCommand(
          ctx,
          ctx.onModel ? () => ctx.onModel?.(args) : undefined,
          getSlashCommandFallbackText(command) ?? "当前 Agent 不支持 /model",
        );
        return { handled: true };
      }
      case "/approve": {
        await handleControlCommand(
          ctx,
          ctx.onApprove,
          getSlashCommandFallbackText(command) ?? "当前没有待审批操作",
        );
        return { handled: true };
      }
      case "/reject": {
        await handleControlCommand(
          ctx,
          ctx.onReject,
          getSlashCommandFallbackText(command) ?? "当前没有待审批操作",
        );
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  } catch (err) {
    logger.error(`[weixin] Slash command error: ${String(err)}`);
    try {
      await sendReply(ctx, `❌ 指令执行失败: ${String(err).slice(0, 200)}`);
    } catch {
      // Sending the failure notice also failed.
    }
    return { handled: true };
  }
}
