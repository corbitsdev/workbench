// The live "what is the agent doing right now" strip for an in-flight
// turn: `chat.agent` events already carry the vendored Interchange
// `InferenceEvent` union verbatim (see `streaming-reply.ts`'s header for
// the wire path), but that module only ever reads `inference.text.delta`
// and the turn-boundary events — every tool call, thinking delta, and
// retry is dropped on the floor. This module is the trust boundary that
// narrows those other event shapes (`inference.tool_call.*`, `tool.*`,
// `inference.thinking.delta`, `inference.retry` — see
// `@intx/types/src/runtime.ts`'s `InferenceEvent`) and the pure
// state machine that turns them into one turn's activity list, plus the
// hook and presentational strip that render it. v1 is live-only: the
// strip disappears the moment the turn ends (`nextTurnActivityState`
// returns `null`), same as `streaming-reply.ts`'s reply text — no
// persisted trace yet.

import { useEffect, useState } from "react";

import {
  describeToolCall,
  resolveToolIdentity,
  toolActivityGlyph,
  type ToolActivityRow,
} from "./tool-activity";
import { LiveToolActivity } from "./tool-activity-view";

export type ToolCallActivity = {
  readonly callId: string;
  readonly name: string;
  readonly input: Record<string, unknown> | undefined;
  readonly status: "running" | "success" | "failed";
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

function parseToolCallStart(
  data: unknown,
): { callId: string; name: string } | null {
  const inner = innerData(data);
  if (inner === null) return null;
  const { callId, name } = inner;
  if (typeof callId !== "string" || typeof name !== "string") return null;
  return { callId, name };
}

function parseToolCallEnd(data: unknown): {
  callId: string;
  name: string;
  arguments: Record<string, unknown> | undefined;
} | null {
  const inner = innerData(data);
  if (inner === null) return null;
  const { callId, name } = inner;
  if (typeof callId !== "string" || typeof name !== "string") return null;
  return { callId, name, arguments: asRecord(inner.arguments) ?? undefined };
}

function parseToolStart(data: unknown): {
  callId: string;
  name: string;
  arguments: Record<string, unknown> | undefined;
} | null {
  const inner = innerData(data);
  const call = inner === null ? null : asRecord(inner.call);
  if (call === null) return null;
  const callId = call.id;
  const name = call.name;
  if (typeof callId !== "string" || typeof name !== "string") return null;
  return { callId, name, arguments: asRecord(call.arguments) ?? undefined };
}

/** A settled tool call, with the one thing the old reading dropped: whether
 * it actually worked. A failed call used to land in the strip as a quiet
 * check mark, indistinguishable from a success. */
function parseToolDone(
  data: unknown,
): { callId: string; isError: boolean } | null {
  const inner = innerData(data);
  const result = inner === null ? null : asRecord(inner.result);
  if (result === null) return null;
  const callId = result.callId;
  if (typeof callId !== "string") return null;
  return { callId, isError: result.isError === true };
}

/**
 * `inference.thinking.delta`'s `data.partial.thinking` is cumulative, same
 * as `partial.text` (see `PartialMessage` in
 * `@intx/types/src/runtime.ts`) — so the ordinary case replaces the
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

/** Records (or refines) one tool call, opening a new running row if
 * `callId` hasn't been seen yet this turn. Never touches `startedAtMs`,
 * `status`, or `doneAtMs` on an existing entry — `inference.tool_call.end`
 * and `tool.start` only ever add the arguments a row already opened by an
 * earlier event was missing. */
function upsertToolCall(
  toolCalls: readonly ToolCallActivity[],
  call: {
    callId: string;
    name: string;
    input: Record<string, unknown> | undefined;
  },
  nowMs: number,
): readonly ToolCallActivity[] {
  const existing = toolCalls.find((entry) => entry.callId === call.callId);
  if (existing === undefined) {
    return [
      ...toolCalls,
      {
        callId: call.callId,
        name: call.name,
        input: call.input,
        status: "running",
        startedAtMs: nowMs,
        doneAtMs: null,
      },
    ];
  }
  return toolCalls.map((entry) =>
    entry.callId === call.callId
      ? { ...entry, name: call.name, input: call.input ?? entry.input }
      : entry,
  );
}

function settleToolCall(
  toolCalls: readonly ToolCallActivity[],
  callId: string,
  isError: boolean,
  nowMs: number,
): readonly ToolCallActivity[] {
  return toolCalls.map((call) =>
    call.callId === callId
      ? {
          ...call,
          status: isError ? ("failed" as const) : ("success" as const),
          doneAtMs: call.doneAtMs ?? nowMs,
        }
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
      toolCalls: upsertToolCall(
        base.toolCalls,
        { callId: parsed.callId, name: parsed.name, input: undefined },
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
      toolCalls: upsertToolCall(
        base.toolCalls,
        {
          callId: parsed.callId,
          name: parsed.name,
          input: parsed.arguments,
        },
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
      toolCalls: upsertToolCall(
        base.toolCalls,
        {
          callId: parsed.callId,
          name: parsed.name,
          input: parsed.arguments,
        },
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
      toolCalls: settleToolCall(
        base.toolCalls,
        parsed.callId,
        parsed.isError,
        nowMs,
      ),
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

/** How long an open turn may sit with no consumed event before the strip
 * clears itself — the backstop for a turn whose `reactor.done`/
 * `inference.done` (or `.error`) never arrives (agent down, SSE dropped
 * mid-reconnect), mirroring `streaming-reply.ts`'s
 * `PENDING_REPLY_CLEAR_MS`. */
const TURN_ACTIVITY_STALE_MS = 120_000;

/**
 * Owns the turn-activity state end to end, mirroring
 * `useStreamingReply`'s shape exactly: feed it every stream event and it
 * tracks the active turn's tool calls, thinking, and retries, clearing
 * the moment the turn ends. `workbenchId` resets it immediately on a
 * workbench switch — activity from the workbench just left belongs to that
 * workbench, not the new one. `staleMs` (default `TURN_ACTIVITY_STALE_MS`)
 * is a test seam, mirroring `useTypingIndicator`'s own configurable
 * timeout.
 */
export function useTurnActivity(
  workbenchId: string | null,
  staleMs: number = TURN_ACTIVITY_STALE_MS,
): {
  readonly activity: TurnActivityState;
  readonly handleStreamEvent: (eventType: string, data: unknown) => void;
} {
  const [activity, setActivity] = useState<TurnActivityState>(null);

  useEffect(() => {
    setActivity(null);
  }, [workbenchId]);

  // Reset (clear + re-arm) on every event that actually changes the
  // activity object — an ignored event never resets the clock, since
  // nothing about the open turn changed. A dropped stream leaves
  // `activity` referentially stable forever, so this timer is the only
  // thing that ever clears it in that case.
  useEffect(() => {
    if (activity === null) return;
    const timer = setTimeout(() => {
      setActivity((current) => (current === activity ? null : current));
    }, staleMs);
    return () => clearTimeout(timer);
  }, [activity, staleMs]);

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
 * This turn's tool calls as the rows the conversation renders everywhere
 * else — same sentences, same statuses. A call still running says so in
 * the present tense and carries how long it has been going; a settled one
 * drops the timer, since a finished step's duration is noise.
 */
export function toolActivityRows(
  activity: NonNullable<TurnActivityState>,
  nowMs: number,
): readonly ToolActivityRow[] {
  return activity.toolCalls.map((call) => {
    const isRunning = call.status === "running";
    const identity = resolveToolIdentity(call.name, call.input);
    const base = {
      key: call.callId,
      toolName: identity.toolName,
      glyph: toolActivityGlyph(identity.words),
      provider: identity.provider,
      phrase: describeToolCall(
        call.name,
        call.input,
        isRunning ? "present" : "past",
      ),
      detail: undefined,
      status: call.status,
    };
    if (!isRunning) return base;
    return { ...base, meta: `${elapsedSeconds(call.startedAtMs, nowMs)}s` };
  });
}

/**
 * The live strip: one row per tool call this turn, a "Thinking…" row while
 * thinking deltas are flowing, and a retry note if the model's own request
 * needed one. Renders nothing once the turn ends — the persisted message
 * takes over from there, in the same row idiom.
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

  return (
    <LiveToolActivity
      rows={toolActivityRows(activity, Date.now())}
      thinking={activity.thinking.active}
      retryCount={activity.retryCount}
    />
  );
}
