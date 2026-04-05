import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionId,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

function describeToolCall(update: {
  title?: string | null;
  kind?: string | null;
  toolCallId?: string;
}): string {
  return update.title ?? update.kind ?? update.toolCallId ?? "tool";
}

export type AcpConnectionHandlers = {
  onExit?: () => void;
  onRequestPermission?: (
    params: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  onSessionUpdate?: (notification: SessionNotification) => void;
};

/**
 * Manages the ACP agent subprocess and ClientSideConnection lifecycle.
 */
export class AcpConnection {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private ready = false;
  private readyPromise: Promise<ClientSideConnection> | null = null;
  private collectors = new Map<SessionId, ResponseCollector>();

  private options: AcpAgentOptions;
  private handlers: AcpConnectionHandlers;

  constructor(options: AcpAgentOptions, handlers: AcpConnectionHandlers = {}) {
    this.options = options;
    this.handlers = handlers;
  }

  registerCollector(sessionId: SessionId, collector: ResponseCollector): void {
    this.collectors.set(sessionId, collector);
  }

  unregisterCollector(sessionId: SessionId): void {
    this.collectors.delete(sessionId);
  }

  /**
   * Ensure the subprocess is running and the connection is initialized.
   */
  async ensureReady(): Promise<ClientSideConnection> {
    if (this.ready && this.connection) {
      return this.connection;
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = (async () => {
      const args = this.options.args ?? [];
      log(`spawning: ${this.options.command} ${args.join(" ")}`);

      const proc = spawn(this.options.command, args, {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, ...this.options.env },
        cwd: this.options.cwd,
      });
      this.process = proc;

      proc.on("exit", (code) => {
        if (this.process !== proc) {
          return;
        }
        log(`subprocess exited (code=${code})`);
        this.ready = false;
        this.readyPromise = null;
        this.connection = null;
        this.process = null;
        this.handlers.onExit?.();
      });

      const writable = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
      const readable = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
      const stream = ndJsonStream(writable, readable);

      const conn = new ClientSideConnection((_agent) => ({
        sessionUpdate: async (params) => {
          const update = params.update;
          switch (update.sessionUpdate) {
            case "tool_call":
              log(`tool_call: ${describeToolCall(update)} (${update.status ?? "started"})`);
              break;
            case "tool_call_update":
              if (update.status) {
                log(`tool_call_update: ${describeToolCall(update)} → ${update.status}`);
              }
              break;
            case "agent_thought_chunk":
              if (update.content.type === "text") {
                log(`thinking: ${update.content.text.slice(0, 100)}`);
              }
              break;
          }
          const collector = this.collectors.get(params.sessionId);
          if (collector) {
            collector.handleUpdate(params);
          }
          this.handlers.onSessionUpdate?.(params);
        },
        requestPermission: async (params) => {
          if (!this.handlers.onRequestPermission) {
            throw new Error("ACP permission handler is not configured");
          }
          return this.handlers.onRequestPermission(params);
        },
      }), stream);

      log("initializing connection...");
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "weixin-agent-sdk", version: "0.1.0" },
        clientCapabilities: {},
      });
      log("connection initialized");

      this.connection = conn;
      this.ready = true;
      return conn;
    })();

    try {
      return await this.readyPromise;
    } catch (error) {
      this.ready = false;
      this.readyPromise = null;
      this.connection = null;
      this.process = null;
      throw error;
    }
  }

  /**
   * Kill the subprocess and clean up.
   */
  dispose(): void {
    this.ready = false;
    this.readyPromise = null;
    this.collectors.clear();
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connection = null;
  }
}
