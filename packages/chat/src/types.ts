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

/**
 * Ordered message parts, mirroring Vercel UIMessage part discriminants.
 *
 * Deliberately narrower than UIMessage: only fields the Interchange event
 * stream (`InstanceEvent` turns/mails, `convertInstanceEvents`,
 * `composeChatMessages`) can actually populate. No `data-*` parts, no
 * `source-url` / `source-document` parts, no permanently-empty stubs.
 *
 * Two-tier fidelity (see the package README, "Parts model" section, for the
 * full writeup): a LIVE turn can interleave these in true stream order (think →
 * tool → think → answer). A HYDRATED turn — reloaded from the hub-client
 * contract, which only exposes cumulative `reasoning` + a `toolCalls` array
 * per turn/mail — has no interleaving left to recover, so `liftToParts`
 * synthesizes a deterministic flat layout instead (see its TSDoc). This is
 * an accepted data-level limitation; the default transcript render (answer +
 * optional activity footnote) must look identical either way — the
 * difference is only observable in an expanded trace view.
 */
export const TextPartSchema = type({
  type: "'text'",
  text: "string",
});
/** Plain answer text — the model's final or in-progress reply segment. */
export type TextPart = typeof TextPartSchema.infer;

export const ReasoningPartSchema = type({
  type: "'reasoning'",
  text: "string",
});
/**
 * Chain-of-thought / thinking text. Interchange only ever gives us a single
 * cumulative reasoning string per turn (no per-segment boundaries), so this
 * part carries text only — no UIMessage-style `providerMetadata`.
 */
export type ReasoningPart = typeof ReasoningPartSchema.infer;

export const ToolPartStateSchema = type("'pending' | 'output-available' | 'output-error'");
/**
 * Tool call lifecycle state, restricted to what the event stream emits.
 * `ToolCall.result` is undefined until the call resolves (→ `pending`); once
 * it resolves, `ToolCall.isError` selects `output-available` vs
 * `output-error`. UIMessage's `input-streaming` / `input-available` states
 * are not represented — Interchange delivers tool arguments atomically, not
 * as a streamed-then-finalized input.
 */
export type ToolPartState = typeof ToolPartStateSchema.infer;

export const ToolPartSchema = type({
  type: "'tool'",
  toolCallId: "string",
  toolName: "string",
  state: ToolPartStateSchema,
  "label?": "string",
  "input?": "Record<string, unknown>",
  "output?": "string",
  "errorText?": "string",
});
/** A tool invocation, mapped 1:1 from a `ToolCall`. */
export type ToolPart = typeof ToolPartSchema.infer;

export const FilePartSchema = type({
  type: "'file'",
  mediaType: "string",
  /**
   * Reference to the bytes, never fetched by this package. For a persisted
   * `ChatAttachment` this is a `blob:<blobId>` marker the host resolves via
   * `resolveAttachmentUrl`. For a live `ChatImage` (which only ever carries
   * inline base64) this is a `data:<mimeType>;base64,<data>` URI — decided
   * here rather than adding a second "inline" part variant, since a file
   * part's job (something with bytes and a media type) covers both cases.
   */
  url: "string",
  "filename?": "string",
  "blobId?": "string",
  "size?": "number",
});
/** A file — lifted from either a `ChatAttachment` or a `ChatImage`. */
export type FilePart = typeof FilePartSchema.infer;

export const PartSchema = TextPartSchema.or(ReasoningPartSchema)
  .or(ToolPartSchema)
  .or(FilePartSchema);
/** One entry in a message's ordered `parts` array. */
export type Part = typeof PartSchema.infer;

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
  /**
   * Ordered parts view of the same message. Additive: `content`, `reasoning`,
   * `toolCalls`, `images`, and `attachments` above remain the source of
   * truth for existing renderers until the renderer rebuild (a later
   * ticket) reads `parts` instead. Populated either by a parts-native write
   * path or by lifting a flat message through `liftToParts`.
   */
  "parts?": PartSchema.array(),
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
