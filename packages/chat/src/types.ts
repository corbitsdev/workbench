/**
 * Domain types for the personal agent (Myra) chat UI.
 *
 * This package is intentionally stateless: it describes the shape of chat data
 * and the handlers a host supplies, but performs no transport. Real agent
 * transport (POST /agents/instances/:paId/mail, outbox polling) is wired by the
 * host application in CL-991, outside this package.
 *
 * The message/part data model (`ChatMessage`, `Part` and its variants,
 * `ToolCall`, `ChatImage`, `ChatAttachment`, `ChatActivity`) lives in
 * `@workbench/agent-core` — `@workbench/agents` (sidecar runtime closure)
 * builds and consumes these shapes and must not depend on this
 * frontend-only package. Re-exported here so existing imports of
 * `@workbench/chat/types` keep working unchanged.
 */

import { type } from "arktype";

export {
  ChatRoleSchema,
  ChatMessageStatusSchema,
  ChatMessageKindSchema,
  ToolCallSchema,
  ChatImageSchema,
  ChatAttachmentSchema,
  TextPartSchema,
  ReasoningPartSchema,
  ToolPartStateSchema,
  ToolPartSchema,
  FilePartSchema,
  PartSchema,
  ChatMessageSchema,
} from "@workbench/agent-core/parts";
export type {
  ChatRole,
  ChatMessageStatus,
  ChatMessageKind,
  ToolCall,
  ChatImage,
  ChatAttachment,
  TextPart,
  ReasoningPart,
  ToolPartState,
  ToolPart,
  FilePart,
  Part,
  ChatMessage,
  ChatActivity,
} from "@workbench/agent-core/parts";

export const QuickReplySchema = type({
  id: "string",
  label: "string",
  "value?": "string",
});
/** A tappable suggested reply offered by the agent. */
export type QuickReply = typeof QuickReplySchema.infer;

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
