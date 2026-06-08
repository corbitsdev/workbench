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

/**
 * Optional classification of a message's purpose.
 * - `tool` — intermediate tool call / result (eligible for compaction)
 * - `artifact` — a final output (never compacted)
 * Absent means a regular conversational message.
 */
export type ChatMessageKind = 'tool' | 'artifact';

/** A completed or in-progress tool invocation attached to an agent message. */
export interface ToolCall {
  id: string;
  /** Raw tool name as returned by the agent runtime. */
  name: string;
  /** Human-readable label. When absent the host should derive one from `name`. */
  label?: string;
  /** Arguments the tool was invoked with, e.g. `{ query: "minimax m3" }`. */
  arguments?: Record<string, unknown>;
  /** Result text. Absent when the call is still in-flight. */
  result?: string;
  /** True when the tool returned an error result. */
  isError?: boolean;
}

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
  /**
   * Optional classification. Tool messages are eligible for compaction in long
   * threads; artifact messages are always fully visible.
   */
  kind?: ChatMessageKind;
  /**
   * Tool calls made during this agent turn. The host populates these from the
   * agent runtime event stream. A call whose `result` is absent is treated as
   * still in-flight (renders with a pulse indicator).
   */
  toolCalls?: ToolCall[];
}

/** A tappable suggested reply offered by the agent. */
export interface QuickReply {
  id: string;
  label: string;
  /** Optional payload sent instead of the visible label when chosen. */
  value?: string;
}

/** What the agent is currently doing, shown as a status indicator. */
export type ChatActivity =
  | { type: 'thinking' }
  | { type: 'tool_call'; name: string }
  | { type: 'tool_running'; name: string }
  | { type: 'rate_limited'; retryAfterMs: number };

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
