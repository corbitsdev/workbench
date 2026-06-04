/**
 * Domain types for the personal agent (Ada) chat UI.
 *
 * This package is intentionally stateless: it describes the shape of chat data
 * and the handlers a host supplies, but performs no transport. Real agent
 * transport (POST /agents/instances/:paId/mail, outbox polling) is wired by the
 * host application in CL-991, outside this package.
 */

/** Who authored a chat message. */
export type ChatRole = 'user' | 'agent' | 'system';

/** Delivery state of a message, used to render ticks / spinners / retries. */
export type ChatMessageStatus = 'sending' | 'sent' | 'failed';

/** A single message in a chat thread. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Plain-text body. Rendering is left to the host if richer content is needed. */
  content: string;
  /** ISO-8601 timestamp of when the message was created. */
  createdAt: string;
  /** Delivery state. Absent means delivered/no tracking needed. */
  status?: ChatMessageStatus;
}

/** A tappable suggested reply offered by the agent. */
export interface QuickReply {
  id: string;
  label: string;
  /** Optional payload sent instead of the visible label when chosen. */
  value?: string;
}

/** Whether the chat is shown as a floating overlay or docked into the layout. */
export type ChatDockState = 'floating' | 'docked';

/** Whether the floating launcher / panel is open or closed. */
export type ChatOpenState = 'open' | 'closed';

/** Screen position for the floating launcher and panel. */
export interface ChatLauncherPosition {
  x: number;
  y: number;
}

/** Identity shown in the panel header. */
export interface ChatAgentIdentity {
  /** Display name, e.g. "Ada". */
  name: string;
  /** Optional short subtitle, e.g. "Personal agent". */
  tagline?: string;
}
