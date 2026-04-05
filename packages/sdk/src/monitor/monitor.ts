import type { Agent } from "../agent/interface.js";
import { getUpdates } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { SESSION_EXPIRED_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import type { MessageItem } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { processOneMessage } from "../messaging/process-message.js";
import { getSlashCommandPriority } from "../messaging/slash-commands.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";
import { createConversationDispatcher } from "./conversation-dispatcher.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type MonitorWeixinOpts = {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  agent: Agent;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  log?: (msg: string) => void;
};

function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) {
    return "";
  }
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

function getInboundConversationResetVersion(
  dispatcher: ReturnType<typeof createConversationDispatcher>,
  conversationId: string,
  textBody: string,
): number {
  if (shouldReserveConversationReset(textBody)) {
    // Reserve the new session boundary before enqueueing later messages from the same poll.
    return dispatcher.markConversationReset(conversationId);
  }

  return dispatcher.getConversationResetVersion(conversationId);
}

function shouldReserveConversationReset(textBody: string): boolean {
  const trimmed = textBody.trim().toLowerCase();
  if (!trimmed.startsWith("/")) {
    return false;
  }

  const spaceIdx = trimmed.indexOf(" ");
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  return name === "/new" || name === "/clear";
}

/**
 * Long-poll loop: getUpdates → process message → call agent → send reply.
 * Runs until aborted.
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const {
    baseUrl,
    cdnBaseUrl,
    token,
    accountId,
    agent,
    abortSignal,
    longPollTimeoutMs,
  } = opts;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const errLog = (msg: string) => {
    log(msg);
    logger.error(msg);
  };
  const aLog = logger.withAccount(accountId);

  log(`[weixin] monitor started (${baseUrl}, account=${accountId})`);
  aLog.info(`Monitor started: baseUrl=${baseUrl}`);

  const syncFilePath = getSyncBufFilePath(accountId);
  const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
  let getUpdatesBuf = previousGetUpdatesBuf ?? "";

  if (previousGetUpdatesBuf) {
    log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log(`[weixin] no previous sync buf, starting fresh`);
  }

  const configManager = new WeixinConfigManager({ baseUrl, token }, log);
  const dispatcher = createConversationDispatcher();

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          pauseSession(accountId);
          const pauseMs = getRemainingPauseMs(accountId);
          errLog(
            `[weixin] session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing for ${Math.ceil(pauseMs / 60_000)} min. Please run \`npx weixin-acp login\` to re-login.`,
          );
          consecutiveFailures = 0;
          await sleep(pauseMs, abortSignal);
          continue;
        }

        consecutiveFailures += 1;
        errLog(
          `[weixin] getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog(`[weixin] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const list = resp.msgs ?? [];
      for (const full of list) {
        const conversationId = full.from_user_id ?? "";
        const textBody = extractTextBody(full.item_list);
        const priority = getSlashCommandPriority(textBody);
        const conversationResetVersion = getInboundConversationResetVersion(
          dispatcher,
          conversationId,
          textBody,
        );

        void dispatcher
          .dispatch({
            conversationId,
            priority,
            run: async () => {
              aLog.info(
                `inbound: from=${full.from_user_id} priority=${priority} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`,
              );

              const cachedConfig = await configManager.getForUser(
                conversationId,
                full.context_token,
              );

              await processOneMessage(full, {
                accountId,
                agent,
                baseUrl,
                cdnBaseUrl,
                token,
                typingTicket: cachedConfig.typingTicket,
                log,
                errLog,
                conversationController: dispatcher,
                conversationResetVersion,
              });
            },
          })
          .catch((error) => {
            errLog(
              `[weixin] inbound dispatch failed: conversation=${conversationId} priority=${priority} error=${String(error)}`,
            );
          });
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        aLog.info(`Monitor stopped (aborted)`);
        return;
      }
      consecutiveFailures += 1;
      errLog(
        `[weixin] getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
  aLog.info(`Monitor ended`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
