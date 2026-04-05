/**
 * Agent interface — any AI backend that can handle a chat message.
 *
 * Implement this interface to connect WeChat to your own AI service.
 * The WeChat bridge calls `chat()` for each inbound message and sends
 * the returned response back to the user.
 */

export interface Agent {
  /** Process a single message and return a reply. */
  chat(request: ChatRequest, context?: ChatContext): Promise<ChatResponse>;
  /** Clear/reset the session for a given conversation. */
  clearSession?(conversationId: string): void | Promise<void>;
  /** Cancel the in-flight turn for a given conversation. */
  cancelTurn?(conversationId: string): Promise<void>;
  /** Return a human-readable status summary for the conversation. */
  getStatus?(conversationId: string): Promise<AgentStatusResult>;
  /** Return configurable options for the conversation. */
  getConfigOptions?(conversationId: string): Promise<AgentConfigOptionsResult>;
  /** Apply a single config option change to the conversation. */
  setConfigOption?(
    conversationId: string,
    configId: string,
    value: string,
  ): Promise<AgentConfigSetResult>;
}

export interface ChatRequest {
  /** Conversation / user identifier. Use this to maintain per-user context. */
  conversationId: string;
  /** Text content of the message. */
  text: string;
  /** Attached media file (image, audio, video, or generic file). */
  media?: {
    type: "image" | "audio" | "video" | "file";
    /** Local file path (already downloaded and decrypted). */
    filePath: string;
    /** MIME type, e.g. "image/jpeg", "audio/wav". */
    mimeType: string;
    /** Original filename (available for file attachments). */
    fileName?: string;
  };
}

export interface ChatResponse {
  /** Reply text (may contain markdown — will be converted to plain text before sending). */
  text?: string;
  /** Reply media file. */
  media?: {
    type: "image" | "video" | "file";
    /** Local file path or HTTPS URL. */
    url: string;
    /** Filename hint (for file attachments). */
    fileName?: string;
  };
}

export interface ChatContext {
  requestPermission(input: PermissionRequest): Promise<PermissionDecision>;
}

export interface PermissionRequest {
  conversationId: string;
  requestId: string;
  title?: string;
  kind?: string;
  options: PermissionOption[];
}

export interface PermissionOption {
  id: string;
  kind?: string;
  name: string;
  description?: string;
}

export type PermissionDecision =
  | {
      outcome: "selected";
      optionId: string;
    }
  | {
      outcome: "rejected";
    }
  | {
      outcome: "cancelled";
    };

export interface AgentStatusResult {
  text: string;
}

export interface AgentConfigOptionsResult {
  text?: string;
  options: AgentConfigOption[];
}

export interface AgentConfigOption {
  id: string;
  label?: string;
  description?: string;
  value?: string;
  options?: AgentConfigOptionValue[];
}

export interface AgentConfigOptionValue {
  value: string;
  label?: string;
  description?: string;
}

export interface AgentConfigSetResult {
  text?: string;
}
