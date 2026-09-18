// v1 is live-only: the strip disappears the moment the turn ends, same as
// `streaming-reply.ts`'s reply text — no persisted trace yet.

import { useEffect, useState } from "react";

import { REAL_CLOCK, type Clock } from "./clock";
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
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
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
function parseToolDone(data: unknown): { callId: string; isError: boolean } | null {
  const inner = innerData(data);
  const result = inner === null ? null : asRecord(inner.result);
  if (result === null) return null;
  const callId = result.callId;
  if (typeof callId !== "string") return null;
  return { callId, isError: result.isError === true };
}

// `partial.thinking` is cumulative, so the ordinary case replaces the char
// count outright; a future adapter omitting it falls back to `token`'s
// length as an increment instead.
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

// Never touches `startedAtMs`/`status`/`doneAtMs` on an existing entry —
// a later event only ever fills in arguments an earlier one was missing.
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

// Opens the activity implicitly if none exists yet, so an event arriving
// before `reactor.start` is never silently dropped. Kept pure and separate
// from the `useState` that holds it, matching `nextStreamingReplyState`.
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
      parsed.kind === "cumulative" ? parsed.charCount : base.thinking.charCount + parsed.charCount;
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
      toolCalls: settleToolCall(base.toolCalls, parsed.callId, parsed.isError, nowMs),
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

// Backstop for a turn whose done/error event never arrives (agent down,
// SSE dropped mid-reconnect), mirroring `streaming-reply.ts`.
const TURN_ACTIVITY_STALE_MS = 120_000;

// `workbenchId` resets state immediately on a workbench switch — activity
// from the one just left doesn't belong to the new one. `staleMs`/`clock`
// are test seams so a test can drive time synchronously.
export function useTurnActivity(
  workbenchId: string | null,
  staleMs: number = TURN_ACTIVITY_STALE_MS,
  clock: Clock = REAL_CLOCK,
): {
  readonly activity: TurnActivityState;
  readonly handleStreamEvent: (eventType: string, data: unknown) => void;
} {
  const [activity, setActivity] = useState<TurnActivityState>(null);

  // Another workbench's activity must never show for a frame, so the reset
  // happens during render rather than after the paint that would leak it.
  const [activityFor, setActivityFor] = useState(workbenchId);
  if (activityFor !== workbenchId) {
    setActivityFor(workbenchId);
    setActivity(null);
  }

  // This timer is the only thing that clears `activity` if the stream
  // drops and leaves it referentially stable forever.
  useEffect(() => {
    if (activity === null) return;
    const timer = clock.setTimeout(() => {
      setActivity((current) => (current === activity ? null : current));
    }, staleMs);
    return () => clock.clearTimeout(timer);
  }, [activity, staleMs, clock]);

  function handleStreamEvent(eventType: string, data: unknown) {
    setActivity((current) => nextTurnActivityState(current, { eventType, data }, clock.now()));
  }

  return { activity, handleStreamEvent };
}

function elapsedSeconds(startedAtMs: number, endMs: number): number {
  return Math.max(0, Math.round((endMs - startedAtMs) / 1000));
}

// A running call carries how long it's been going; a settled one drops
// the timer, since a finished step's duration is noise.
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
      phrase: describeToolCall(call.name, call.input, isRunning ? "present" : "past"),
      detail: undefined,
      status: call.status,
    };
    if (!isRunning) return base;
    return { ...base, meta: `${elapsedSeconds(call.startedAtMs, nowMs)}s` };
  });
}

// Renders nothing once the turn ends — the persisted message takes over.
export function TurnActivityStrip({ activity }: { readonly activity: TurnActivityState }) {
  const hasRunningToolCall = activity?.toolCalls.some((call) => call.status === "running") ?? false;
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
