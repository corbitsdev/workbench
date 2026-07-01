/**
 * Domain types for the personal agent (Myra) chat UI.
 *
 * This package is intentionally stateless: it describes the shape of chat data
 * and the handlers a host supplies, but performs no transport. Real agent
 * transport (POST /agents/instances/:paId/mail, outbox polling) is wired by the
 * host application in CL-991, outside this package.
 */

import { type } from "arktype";

export const ChatRoleSchema = type("'user' | 'agent' | 'system'");
/** Who authored a chat message. */
export type ChatRole = typeof ChatRoleSchema.infer;

export const ChatMessageStatusSchema = type("'sending' | 'sent' | 'failed'");
/** Delivery state of a message, used to render ticks / spinners / retries. */
export type ChatMessageStatus = typeof ChatMessageStatusSchema.infer;

export const ChatMessageKindSchema = type("'tool' | 'artifact'");
/**
 * Optional classification of a message's purpose.
 * - `tool` — intermediate tool call / result (eligible for compaction)
 * - `artifact` — a final output (never compacted)
 * Absent means a regular conversational message.
 */
export type ChatMessageKind = typeof ChatMessageKindSchema.infer;

export const ToolCallSchema = type({
  id: "string",
  name: "string",
  "label?": "string",
  "arguments?": "Record<string, unknown>",
  "result?": "string",
  "isError?": "boolean",
});
/** A completed or in-progress tool invocation attached to an agent message. */
export type ToolCall = typeof ToolCallSchema.infer;

export const ChatImageSchema = type({
  mimeType: "string",
  data: "string",
});
/** An inline image captured from the agent's response stream. */
export type ChatImage = typeof ChatImageSchema.infer;

export const ChatAttachmentSchema = type({
  blobId: "string",
  /** Display name; derived from the blob when the mail carried a null name. */
  name: "string",
  type: "string",
  size: "number",
});
/**
 * A stored mail attachment, on either a sent or received message. The bytes are
 * fetched lazily by blobId through the host-supplied `resolveAttachmentUrl` — the
 * chat package stays transport-free and never fetches directly.
 */
export type ChatAttachment = typeof ChatAttachmentSchema.infer;

export const ChatMessageSchema = type({
  id: "string",
  role: ChatRoleSchema,
  content: "string",
  createdAt: "string",
  "feedbackId?": "string",
  "status?": ChatMessageStatusSchema,
  "senderLabel?": "string",
  "kind?": ChatMessageKindSchema,
  "toolCalls?": ToolCallSchema.array(),
  "reasoning?": "string",
  "images?": ChatImageSchema.array(),
  "attachments?": ChatAttachmentSchema.array(),
});
/** A single message in a chat thread. */
export type ChatMessage = typeof ChatMessageSchema.infer;

export const QuickReplySchema = type({
  id: "string",
  label: "string",
  "value?": "string",
});
/** A tappable suggested reply offered by the agent. */
export type QuickReply = typeof QuickReplySchema.infer;

/**
 * What the agent is currently doing, shown as a status indicator.
 *
 * Left as a plain discriminated-union type: the variants carry numeric fields
 * (retryAfterMs) and string-carrying discriminants that are constructed
 * internally by the host adapter — never parsed from an untrusted external
 * source, so runtime validation buys nothing here.
 */
export type ChatActivity =
  | { type: "thinking" }
  | { type: "tool_call"; name: string }
  | { type: "tool_running"; name: string }
  | { type: "rate_limited"; retryAfterMs: number };

/** Whether the chat is shown as a floating overlay or docked into the layout. */
export type ChatDockState = "floating" | "docked";

/** Whether the floating launcher / panel is open or closed. */
export type ChatOpenState = "open" | "closed";

/**
 * Screen position for the floating launcher and panel.
 * Left as plain interface: numeric pixel coordinates constructed internally by
 * drag-and-drop handlers, never parsed from an external source.
 */
export interface ChatLauncherPosition {
  x: number;
  y: number;
}

/**
 * Identity shown in the panel header.
 * Left as plain interface: supplied by the host at component mount as a trusted
 * prop, not parsed from a wire payload.
 */
export interface ChatAgentIdentity {
  /** Display name, e.g. "Myra". */
  name: string;
  /** Optional short subtitle, e.g. "Personal agent". */
  tagline?: string;
}
