// The live "what is the agent doing right now" strip for an in-flight
// turn: `chat.agent` events already carry the vendored Interchange
// `InferenceEvent` union verbatim (see `streaming-reply.ts`'s header for
// the wire path), but that module only ever reads `inference.text.delta`
// and the turn-boundary events — every tool call, thinking delta, and
// retry is dropped on the floor. This module is the trust boundary that
// narrows those other event shapes (`inference.tool_call.*`, `tool.*`,
// `inference.thinking.delta`, `inference.retry` — see
// `vendor/intx/types/src/runtime.ts`'s `InferenceEvent`) and the pure
// state machine that turns them into one turn's activity list, plus the
// hook and presentational strip that render it. v1 is live-only: the
// strip disappears the moment the turn ends (`nextTurnActivityState`
// returns `null`), same as `streaming-reply.ts`'s reply text — no
// persisted trace yet.

import { useEffect, useState } from "react";

import { CHAT_STRINGS } from "./strings";

export type ToolCallActivity = {
  readonly callId: string;
  readonly label: string;
  readonly status: "running" | "done";
  readonly startedAtMs: number;
  readonly doneAtMs: number | null;
};

export type TurnActivityState = {
  readonly toolCalls: readonly ToolCallActivity[];
  readonly thinking: { readonly active: boolean; readonly charCount: number };
  readonly retryCount: number;
} | null;

const EMPTY_ACTIVITY: NonNullable<TurnActivityState> = {
  toolCalls: [],
  thinking: { active: false, charCount: 0 },
  retryCount: 0,
};

/**
 * Resolves a tool call's display name. `mcp_read`/`mcp_call` are the
 * generic MCP dispatch tools (`packages/mcp-tools/src/tool.ts`) — every
 * downstream call looks identical ("mcp_read") unless its own `{server,
 * tool}` arguments are surfaced, so this shows the underlying
 * `server.tool` when both are present and falls back to the bare tool
 * name for everything else (an ordinary tool, or a malformed/absent
 * argument bag).
 */
export function friendlyToolLabel(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  if (name === "mcp_read" || name === "mcp_call") {
    const server = args?.server;
    const tool = args?.tool;
    if (typeof server === "string" && typeof tool === "string") {
      return `${server}.${tool}`;
    }
  }
  return name;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** The bare `type` discriminant of a `chat.agent` payload — mirrors
 * `streaming-reply.ts`'s `innerEventType`, kept local so this module has
 * no cross-file coupling on that private helper. */
function agentEventType(data: unknown): string | null {
  const record = asRecord(data);
  if (record === null) return null;
  const type = record.type;
  return typeof type === "string" ? type : null;
}

function innerData(data: unknown): Record<string, unknown> | null {
  const record = asRecord(data);
  return record === null ? null : asRecord(record.data);
}

function parseToolCallStart(data: unknown): { callId: string; name: string } | null {
  const inner = innerData(data);
  if (inner === null) return null;
  const { callId, name } = inner;
  if (typeof callId !== "string" || typeof name !== "string") return null;
  return { callId, name };
}

function parseToolCallEnd(
  data: unknown,
): { callId: string; name: string; arguments: Record<string, unknown> | undefined } | null {
  const inner = innerData(data);
  if (inner === null) return null;
  const { callId, name } = inner;
  if (typeof callId !== "string" || typeof name !== "string") return null;
  return { callId, name, arguments: asRecord(inner.arguments) ?? undefined };
}

function parseToolStart(
  data: unknown,
): { callId: string; name: string; arguments: Record<string, unknown> | undefined } | null {
  const inner = innerData(data);
  const call = inner === null ? null : asRecord(inner.call);
  if (call === null) return null;
  const callId = call.id;
  const name = call.name;
  if (typeof callId !== "string" || typeof name !== "string") return null;
  return { callId, name, arguments: asRecord(call.arguments) ?? undefined };
}

function parseToolDone(data: unknown): { callId: string } | null {
  const inner = innerData(data);
  const result = inner === null ? null : asRecord(inner.result);
  if (result === null) return null;
  const callId = result.callId;
  return typeof callId === "string" ? { callId } : null;
}

/**
 * `inference.thinking.delta`'s `data.partial.thinking` is cumulative, same
 * as `partial.text` (see `PartialMessage` in
 * `vendor/intx/types/src/runtime.ts`) — so the ordinary case replaces the
 * char count outright. `thinking` is typed optional on `PartialMessage`;
 * if a future adapter omits it on the delta event, falling back to the
 * per-delta `token`'s length keeps the counter moving (as an increment,
 * not a replacement, since `token` is only ever the new fragment).
 */
function parseThinkingDelta(
  data: unknown,
): { kind: "cumulative" | "increment"; charCount: number } | null {
  const inner = innerData(data);
  if (inner === null) return null;
  const partial = asRecord(inner.partial);
  const cumulativeThinking = partial?.thinking;
  if (typeof cumulativeThinking === "string") {
    return { kind: "cumulative", charCount: cumulativeThinking.length };
  }
  const token = inner.token;
  if (typeof token === "string") {
    return { kind: "increment", charCount: token.length };
  }
  return null;
}

function parseRetry(data: unknown): { attempt: number } | null {
  const inner = innerData(data);
  if (inner === null) return null;
  const attempt = inner.attempt;
  return typeof attempt === "number" ? { attempt } : null;
}

/** Sets (or refines) one tool call's label, opening a new running chip if
 * `callId` hasn't been seen yet this turn. Never touches `startedAtMs`,
 * `status`, or `doneAtMs` on an existing entry — `inference.tool_call.end`
 * and `tool.start` only ever add a better label to a chip already opened
 * by an earlier event for the same call. */
function upsertToolCallLabel(
  toolCalls: readonly ToolCallActivity[],
  callId: string,
  label: string,
  nowMs: number,
): readonly ToolCallActivity[] {
  const existing = toolCalls.find((call) => call.callId === callId);
  if (existing === undefined) {
    return [
      ...toolCalls,
      { callId, label, status: "running", startedAtMs: nowMs, doneAtMs: null },
    ];
  }
  return toolCalls.map((call) =>
    call.callId === callId ? { ...call, label } : call,
  );
}

function markToolCallDone(
  toolCalls: readonly ToolCallActivity[],
  callId: string,
  nowMs: number,
): readonly ToolCallActivity[] {
  return toolCalls.map((call) =>
    call.callId === callId
      ? { ...call, status: "done" as const, doneAtMs: call.doneAtMs ?? nowMs }
      : call,
  );
}

/**
 * The current turn's whole activity state machine, pure: `reactor.start`
 * clears it (a fresh turn owns none of the previous turn's chips),
 * `reactor.done`/`reactor.error`/`inference.done`/`inference.error`
 * finalize it to `null` (the turn is over), and every tool-call,
 * thinking, and retry event in between updates the open state — opening
 * one implicitly if none exists yet, so activity that arrives before a
 * `reactor.start` (or in a test driving events directly) is never
 * silently dropped. Kept separate from the `useState` that holds it in
 * `useTurnActivity`, matching `nextStreamingReplyState`'s split in
 * `streaming-reply.ts`.
 */
export function nextTurnActivityState(
  current: TurnActivityState,
  event: { readonly eventType: string; readonly data: unknown },
  nowMs: number,
): TurnActivityState {
  if (event.eventType !== "chat.agent") return current;

  const innerType = agentEventType(event.data);
  if (innerType === "reactor.start") return EMPTY_ACTIVITY;
  if (
    innerType === "reactor.done" ||
    innerType === "reactor.error" ||
    innerType === "inference.done" ||
    innerType === "inference.error"
  ) {
    return null;
  }

  const base = current ?? EMPTY_ACTIVITY;

  // Thinking is only "active" while its own deltas are flowing; any other
  // recognized event means the model has moved on to a new content block,
  // so the char count freezes and the row goes quiet.
  if (innerType === "inference.thinking.delta") {
    const parsed = parseThinkingDelta(event.data);
    if (parsed === null) return base;
    const charCount =
      parsed.kind === "cumulative"
        ? parsed.charCount
        : base.thinking.charCount + parsed.charCount;
    return { ...base, thinking: { active: true, charCount } };
  }
  const thinking = base.thinking.active
    ? { active: false, charCount: base.thinking.charCount }
    : base.thinking;

  if (innerType === "inference.tool_call.start") {
    const parsed = parseToolCallStart(event.data);
    if (parsed === null) return { ...base, thinking };
    return {
      ...base,
      thinking,
      toolCalls: upsertToolCallLabel(
        base.toolCalls,
        parsed.callId,
        friendlyToolLabel(parsed.name, undefined),
        nowMs,
      ),
    };
  }
  if (innerType === "inference.tool_call.end") {
    const parsed = parseToolCallEnd(event.data);
    if (parsed === null) return { ...base, thinking };
    return {
      ...base,
      thinking,
      toolCalls: upsertToolCallLabel(
        base.toolCalls,
        parsed.callId,
        friendlyToolLabel(parsed.name, parsed.arguments),
        nowMs,
      ),
    };
  }
  if (innerType === "tool.start") {
    const parsed = parseToolStart(event.data);
    if (parsed === null) return { ...base, thinking };
    return {
      ...base,
      thinking,
      toolCalls: upsertToolCallLabel(
        base.toolCalls,
        parsed.callId,
        friendlyToolLabel(parsed.name, parsed.arguments),
        nowMs,
      ),
    };
  }
  if (innerType === "tool.done") {
    const parsed = parseToolDone(event.data);
    if (parsed === null) return { ...base, thinking };
    return {
      ...base,
      thinking,
      toolCalls: markToolCallDone(base.toolCalls, parsed.callId, nowMs),
    };
  }
  if (innerType === "inference.retry") {
    const parsed = parseRetry(event.data);
    if (parsed === null) return { ...base, thinking };
    return { ...base, thinking, retryCount: parsed.attempt };
  }

  // `inference.tool_call.delta`, `tool.update`, and every other event this
  // module doesn't render a row for (usage, citations, code execution,
  // …) still close out an active thinking row but otherwise pass through.
  return { ...base, thinking };
}

/**
 * Owns the turn-activity state end to end, mirroring
 * `useStreamingReply`'s shape exactly: feed it every stream event and it
 * tracks the active turn's tool calls, thinking, and retries, clearing
 * the moment the turn ends. `channelId` resets it immediately on a
 * channel switch — activity from the channel just left belongs to that
 * channel, not the new one.
 */
export function useTurnActivity(channelId: string | null): {
  readonly activity: TurnActivityState;
  readonly handleStreamEvent: (eventType: string, data: unknown) => void;
} {
  const [activity, setActivity] = useState<TurnActivityState>(null);

  useEffect(() => {
    setActivity(null);
  }, [channelId]);

  function handleStreamEvent(eventType: string, data: unknown) {
    setActivity((current) =>
      nextTurnActivityState(current, { eventType, data }, Date.now()),
    );
  }

  return { activity, handleStreamEvent };
}

function elapsedSeconds(startedAtMs: number, endMs: number): number {
  return Math.max(0, Math.round((endMs - startedAtMs) / 1000));
}

/**
 * The live strip: one chip per tool call this turn (a pulsing square while
 * running, a quiet check once done, plus elapsed seconds), a "Thinking…"
 * row while thinking deltas are flowing, and a retry note if the model's
 * own request needed one. Renders nothing once the turn ends — the
 * persisted message takes over from there (v1 has no persisted trace).
 */
export function TurnActivityStrip({
  activity,
}: {
  readonly activity: TurnActivityState;
}) {
  const hasRunningToolCall =
    activity?.toolCalls.some((call) => call.status === "running") ?? false;
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!hasRunningToolCall) return;
    const timer = setInterval(() => forceTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [hasRunningToolCall]);

  if (activity === null) return null;
  const { toolCalls, thinking, retryCount } = activity;
  if (toolCalls.length === 0 && !thinking.active && retryCount === 0) {
    return null;
  }

  return (
    <div className="chat-turn-activity" role="status">
      {toolCalls.map((call) => (
        <div
          key={call.callId}
          className="chat-turn-activity-row"
          data-status={call.status}
        >
          <span className="chat-turn-activity-marker" aria-hidden="true" />
          <span className="chat-turn-activity-label">{call.label}</span>
          <span className="chat-turn-activity-elapsed">
            {elapsedSeconds(call.startedAtMs, call.doneAtMs ?? Date.now())}s
          </span>
        </div>
      ))}
      {thinking.active ? (
        <div className="chat-turn-activity-row chat-turn-activity-thinking">
          {CHAT_STRINGS.turnActivityThinking}
        </div>
      ) : null}
      {retryCount > 0 ? (
        <div className="chat-turn-activity-row chat-turn-activity-retry">
          {CHAT_STRINGS.turnActivityRetry(retryCount)}
        </div>
      ) : null}
    </div>
  );
}
