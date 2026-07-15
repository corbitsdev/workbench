import type { Transport } from "@intx/hub-client";
import type { ChatActivity, ChatImage, Part } from "@workbench/chat/types";

/**
 * The single live-turn event consumer that replaces the four separate
 * trackers (tool-name, live-text, reasoning, image) plus the session's own
 * `activity` signal.
 *
 * It subscribes once to the raw agent event stream and incrementally builds
 * an ordered `Part[]` for the turn currently in flight, alongside the legacy
 * flat fields (`text`, `reasoning`, `toolNames`, `liveImages`) so
 * `composeChatMessages` keeps working unchanged. Live activity is no longer a
 * second signal read off the session — it is derived from whichever part is
 * "open" (the trailing part of `parts`), so there is exactly one owner of
 * "what is the agent doing right now."
 *
 * State resets entirely on turn end (`turn.committed`, `reactor.abort`,
 * `reactor.error`, `inference.error`) — the same reset the four trackers
 * performed — except `toolNames`, which (like the original tool-name
 * tracker) is a durable callId -> name map that survives across turns.
 *
 * Live reasoning AND live text both arrive as cumulative blobs per turn, with
 * no per-segment boundaries. Interleaving (text/think -> tool -> text/think)
 * is reconstructed with a consumed-cursor per blob: each tool or image
 * boundary snapshots how much of the blob is already emitted, and the next
 * part carries only the slice after the cursor. A cursor past the end of the
 * blob means a turn-end event was missed (reconnect gap) — the cursor resets
 * so the new turn's content still surfaces instead of being sliced away.
 *
 * `onUpdate` fires only for events the session's own `onChange` does not
 * already re-render on (tool-call name resolution and the local
 * `closeOpenPart`). Per-token deltas deliberately do NOT fire it: the session
 * and the assembler are two SSE connections to the same endpoint, and firing
 * on both would render twice per token.
 */
export interface PartAssembler {
  /** Ordered parts for the turn currently streaming. Empty between turns. */
  readonly parts: Part[];
  /** Legacy flat view: the current turn's live answer text. */
  readonly text: string;
  /** Legacy flat view: the current turn's live reasoning text (cumulative). */
  readonly reasoning: string;
  /** Durable callId -> tool-name map, kept across turns. */
  readonly toolNames: ReadonlyMap<string, string>;
  /** Legacy flat view: inline images captured from the current turn. */
  readonly liveImages: ChatImage[];
  /** What the agent is doing right now, derived from the trailing part. */
  readonly activity: ChatActivity | null;
  /**
   * Closes whatever part is currently open, without resetting the turn's
   * accumulated parts/text/reasoning. Used on abort: the sidecar settles an
   * aborted turn by going to sleep, emitting no further events, so nothing
   * would otherwise clear the "thinking"/"running" indicator.
   */
  closeOpenPart: () => void;
  /** Tears down the underlying event subscription. */
  stop: () => void;
}

type OpenKind = "text" | "reasoning" | "tool" | null;

const TURN_END_EVENTS = new Set([
  "turn.committed",
  "reactor.abort",
  "reactor.error",
  "inference.error",
]);

function eventType(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { type } = raw as { type?: unknown };
  return typeof type === "string" ? type : null;
}

function eventData(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { data } = raw as { data?: unknown };
  if (typeof data !== "object" || data === null) return null;
  return data as Record<string, unknown>;
}

function partialField(
  data: Record<string, unknown>,
  field: string,
): string | null {
  const { partial } = data;
  if (typeof partial !== "object" || partial === null) return null;
  const value = (partial as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function parseToolCallEvent(
  raw: unknown,
): { phase: "start" | "end"; callId: string; name: string } | null {
  const type = eventType(raw);
  if (
    type !== "inference.tool_call.start" &&
    type !== "inference.tool_call.end"
  ) {
    return null;
  }
  const data = eventData(raw);
  if (data === null) return null;
  const { callId, name } = data;
  if (typeof callId !== "string" || typeof name !== "string") return null;
  return {
    phase: type === "inference.tool_call.start" ? "start" : "end",
    callId,
    name,
  };
}

function parseImageOutput(raw: unknown): ChatImage | null {
  if (eventType(raw) !== "inference.image_output") return null;
  const data = eventData(raw);
  if (data === null) return null;
  const { image } = data;
  if (typeof image !== "object" || image === null) return null;
  const { source } = image as { source?: unknown };
  if (typeof source !== "object" || source === null) return null;
  const {
    kind,
    mimeType,
    data: imgData,
  } = source as { kind?: unknown; mimeType?: unknown; data?: unknown };
  if (kind !== "base64") return null;
  if (typeof mimeType !== "string" || typeof imgData !== "string") return null;
  return { mimeType, data: imgData };
}

export function createPartAssembler(
  transport: Transport,
  params: { tenantId: string; instanceId: string },
  onUpdate?: () => void,
): PartAssembler {
  const toolNames = new Map<string, string>();
  let parts: Part[] = [];
  let text = "";
  let textConsumed = 0;
  let reasoning = "";
  let reasoningConsumed = 0;
  let liveImages: ChatImage[] = [];
  let openKind: OpenKind = null;
  let active = false;

  const path = `/api/tenants/${params.tenantId}/agents/instances/${params.instanceId}/events`;

  function resetTurn() {
    parts = [];
    text = "";
    textConsumed = 0;
    reasoning = "";
    reasoningConsumed = 0;
    liveImages = [];
    openKind = null;
    active = false;
  }

  // A tool or image boundary: whatever text/reasoning is already emitted
  // belongs to the parts before the boundary; the next delta opens a fresh
  // part carrying only the slice after these cursors.
  function snapshotBlobCursors() {
    textConsumed = text.length;
    reasoningConsumed = reasoning.length;
  }

  function currentActivity(): ChatActivity | null {
    const trailing = parts[parts.length - 1];
    if (openKind === "reasoning" && trailing?.type === "reasoning") {
      return { type: "thinking" };
    }
    if (
      openKind === "tool" &&
      trailing?.type === "tool" &&
      trailing.state === "pending"
    ) {
      return { type: "tool_running", name: trailing.toolName };
    }
    if (openKind === "text") return null;
    return active ? { type: "thinking" } : null;
  }

  function handleToolCallStart(callId: string, name: string) {
    if (toolNames.get(callId) !== name) toolNames.set(callId, name);
    snapshotBlobCursors();
    parts = [
      ...parts,
      { type: "tool", toolCallId: callId, toolName: name, state: "pending" },
    ];
    openKind = "tool";
    active = true;
  }

  function handleToolCallEnd(callId: string, name: string) {
    if (toolNames.get(callId) !== name) toolNames.set(callId, name);
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (
        part?.type === "tool" &&
        part.toolCallId === callId &&
        part.state === "pending"
      ) {
        part.state = "output-available";
        break;
      }
    }
  }

  function handleTextDelta(next: string) {
    if (next === text && openKind === "text") return;
    // Cursor past the blob means a turn-end event was missed (reconnect gap)
    // and this is a new turn's blob — reset so its content still surfaces.
    if (next.length < textConsumed) textConsumed = 0;
    text = next;
    const segment = next.slice(textConsumed);
    if (openKind === "text") {
      const last = parts[parts.length - 1];
      if (last?.type === "text") last.text = segment;
      return;
    }
    parts = [...parts, { type: "text", text: segment }];
    openKind = "text";
    active = true;
  }

  function handleThinkingDelta(nextTotal: string) {
    if (nextTotal === reasoning) return;
    if (nextTotal.length < reasoningConsumed) reasoningConsumed = 0;
    reasoning = nextTotal;
    const segment = nextTotal.slice(reasoningConsumed);
    if (openKind === "reasoning") {
      const last = parts[parts.length - 1];
      if (last?.type === "reasoning") last.text = segment;
    } else {
      parts = [...parts, { type: "reasoning", text: segment }];
      openKind = "reasoning";
    }
    active = true;
  }

  function handleImageOutput(image: ChatImage) {
    liveImages = [...liveImages, image];
    parts = [
      ...parts,
      {
        type: "file",
        mediaType: image.mimeType,
        url: `data:${image.mimeType};base64,${image.data}`,
      },
    ];
    // The file part interrupts whatever blob was streaming: close it and
    // snapshot the cursors so the next delta opens a fresh part after the
    // image instead of finding a trailing file part and dropping the update.
    snapshotBlobCursors();
    openKind = null;
    active = true;
  }

  const stop = transport.subscribe(
    path,
    (raw) => {
      const type = eventType(raw);
      if (type === null) return;

      if (TURN_END_EVENTS.has(type)) {
        resetTurn();
        return;
      }

      if (type === "inference.start") {
        active = true;
        return;
      }

      // Tool-call events are the only ones that fire onUpdate: names resolve
      // once per call (not per token) and the session's onChange may land
      // before this connection delivers the name — without a render the
      // committed turn would keep showing a raw call id (CL-1398 class).
      const toolCall = parseToolCallEvent(raw);
      if (toolCall !== null) {
        if (toolCall.phase === "start") {
          handleToolCallStart(toolCall.callId, toolCall.name);
        } else {
          handleToolCallEnd(toolCall.callId, toolCall.name);
        }
        onUpdate?.();
        return;
      }

      const data = eventData(raw);
      if (data === null) return;

      if (type === "inference.text.delta") {
        const value = partialField(data, "text");
        if (value !== null) handleTextDelta(value);
        return;
      }

      if (type === "inference.thinking.delta") {
        const value = partialField(data, "thinking");
        if (value !== null) handleThinkingDelta(value);
        return;
      }

      if (type === "inference.text.replay") {
        if (text !== "") return;
        const { text: replayText } = data;
        if (typeof replayText !== "string") return;
        handleTextDelta(replayText);
        return;
      }

      const image = parseImageOutput(raw);
      if (image !== null) {
        handleImageOutput(image);
      }
    },
    { eventName: "agent.event" },
  );

  return {
    get parts() {
      return parts;
    },
    get text() {
      return text;
    },
    get reasoning() {
      return reasoning;
    },
    toolNames,
    get liveImages() {
      return liveImages;
    },
    get activity() {
      return currentActivity();
    },
    closeOpenPart: () => {
      if (openKind === null) return;
      openKind = null;
      active = false;
      onUpdate?.();
    },
    stop,
  };
}
