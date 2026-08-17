// Pure merge over the five event kinds a per-workbench Timeline draws from
// (chat messages, thread forks, routine runs, tasks, approvals) — one
// wall-clock spine, oldest first, with day dividers and KPI rollups derived
// from the same merged array. No new backend: every input here is already
// fetched by an existing page (chat-ui, routines-api, tasks-ui, api.ts).

import { isAgentAddress } from "@corbits/chat/mentions";
import { localPartOf } from "@corbits/chat/agent-address";
import type { ChannelThread, MessageItem } from "@corbits/chat-ui";

import type { NeedsYouItem } from "./api";
import type { Routine, RoutineRun } from "./routines-api";
import type { Task } from "@corbits/tasks-ui";

export type TimelineMessageEvent = {
  readonly kind: "message";
  readonly id: string;
  readonly at: string;
  readonly senderName: string;
  readonly excerpt: string;
  readonly isAgent: boolean;
};

export type TimelineThreadForkEvent = {
  readonly kind: "thread-fork";
  readonly id: string;
  readonly at: string;
  readonly threadKind: "reply" | "delivery";
  readonly title: string;
  readonly parentMessageId: string | null;
};

export type TimelineRoutineRunEvent = {
  readonly kind: "routine-run";
  readonly id: string;
  readonly at: string;
  readonly routineName: string;
  readonly runId: string;
  readonly status: "ok" | "failed" | "running";
  readonly durationMs: number | null;
};

export type TimelineTaskEvent = {
  readonly kind: "task";
  readonly id: string;
  readonly at: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly status: string;
};

export type TimelineApprovalEvent = {
  readonly kind: "approval";
  readonly id: string;
  readonly at: string;
  readonly agentName: string;
  readonly headline: string;
};

export type TimelineEvent =
  | TimelineMessageEvent
  | TimelineThreadForkEvent
  | TimelineRoutineRunEvent
  | TimelineTaskEvent
  | TimelineApprovalEvent;

const EXCERPT_LIMIT = 120;

function messageExcerpt(item: MessageItem): string {
  const text = item.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
  if (text === "") return "(no text)";
  return text.length > EXCERPT_LIMIT
    ? `${text.slice(0, EXCERPT_LIMIT)}…`
    : text;
}

/** Never the raw address (a per-channel local id shape) — falls back to
 * its friendly local part when the sender has no display name. */
function senderDisplayName(sender: MessageItem["sender"]): string {
  return sender.name ?? localPartOf(sender.address);
}

export function toMessageEvents(
  items: readonly MessageItem[],
): readonly TimelineMessageEvent[] {
  return items.map((item) => ({
    kind: "message",
    id: item.id,
    at: item.createdAt,
    senderName: senderDisplayName(item.sender),
    excerpt: messageExcerpt(item),
    isAgent: isAgentAddress(item.sender.address),
  }));
}

/** Every fork off the channel's root thread — the root itself (the plain
 * channel timeline) never renders as its own spine entry. */
export function toThreadForkEvents(
  threads: readonly ChannelThread[],
): readonly TimelineThreadForkEvent[] {
  return threads
    .filter((thread) => thread.kind !== "root")
    .map((thread) => ({
      kind: "thread-fork",
      id: thread.id,
      at: thread.createdAt,
      threadKind: thread.kind === "reply" ? "reply" : "delivery",
      title: thread.title ?? "Thread",
      parentMessageId: thread.parentMessageId,
    }));
}

/** This workbench's own routines — the ones that deliver into it, not
 * every routine the owning bench has defined. */
export function routinesForChannel(
  routines: readonly Routine[],
  channelId: string,
): readonly Routine[] {
  return routines.filter((routine) => routine.deliveryChannelId === channelId);
}

function embeddedRunField(run: RoutineRun, key: string): unknown {
  return run.run?.[key];
}

export function routineRunStatus(
  run: RoutineRun,
): "ok" | "failed" | "running" {
  if (run.error !== undefined && run.error !== null) return "failed";
  const status = embeddedRunField(run, "status");
  if (status === "running") return "running";
  if (status === "failed" || status === "error") return "failed";
  return "ok";
}

/**
 * Best-effort elapsed time from the run's own embedded record — `null`
 * (never a fabricated duration) when the record carries no `endedAt`, e.g.
 * a still-running or synthetic schedule-failed row.
 */
export function routineRunDurationMs(run: RoutineRun): number | null {
  const endedRaw = embeddedRunField(run, "endedAt");
  if (typeof endedRaw !== "string") return null;
  const startedRaw = embeddedRunField(run, "createdAt");
  const startIso = typeof startedRaw === "string" ? startedRaw : run.createdAt;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endedRaw);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

export function toRoutineRunEvents(
  routines: readonly Routine[],
  runsByRoutineId: ReadonlyMap<string, readonly RoutineRun[]>,
): readonly TimelineRoutineRunEvent[] {
  const events: TimelineRoutineRunEvent[] = [];
  for (const routine of routines) {
    const runs = runsByRoutineId.get(routine.id) ?? [];
    for (const run of runs) {
      events.push({
        kind: "routine-run",
        id: run.runId,
        at: run.createdAt,
        routineName: routine.name,
        runId: run.runId,
        status: routineRunStatus(run),
        durationMs: routineRunDurationMs(run),
      });
    }
  }
  return events;
}

/** Tasks carry their own `channelId` — this workbench's tasks only. */
export function toTaskEvents(
  tasks: readonly Task[],
  channelId: string,
): readonly TimelineTaskEvent[] {
  return tasks
    .filter((task) => task.channelId === channelId)
    .map((task) => ({
      kind: "task",
      id: task.id,
      at: task.createdAt,
      agentName: task.agentName,
      prompt: task.prompt,
      status: task.status,
    }));
}

/**
 * `needs-you` carries no channel/workbench id (a known v1 gap — see
 * workbench-timeline.tsx), so every pending approval for the owning bench
 * shows up here, not just this workbench's own.
 */
export function toApprovalEvents(
  items: readonly NeedsYouItem[],
): readonly TimelineApprovalEvent[] {
  return items.map((item) => ({
    kind: "approval",
    id: item.id,
    at: item.createdAt,
    agentName: item.agentName,
    headline: item.headline,
  }));
}

export type TimelineEventGroups = {
  readonly messages: readonly TimelineMessageEvent[];
  readonly threadForks: readonly TimelineThreadForkEvent[];
  readonly routineRuns: readonly TimelineRoutineRunEvent[];
  readonly tasks: readonly TimelineTaskEvent[];
  readonly approvals: readonly TimelineApprovalEvent[];
};

/** One wall-clock spine, oldest first. An event with an unparseable
 * timestamp is dropped rather than sorted arbitrarily. */
export function mergeTimelineEvents(
  groups: TimelineEventGroups,
): readonly TimelineEvent[] {
  const all: TimelineEvent[] = [
    ...groups.messages,
    ...groups.threadForks,
    ...groups.routineRuns,
    ...groups.tasks,
    ...groups.approvals,
  ];
  return all
    .filter((event) => !Number.isNaN(Date.parse(event.at)))
    .sort((a, b) => {
      const delta = Date.parse(a.at) - Date.parse(b.at);
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    });
}

export type TimelineDayGroup = {
  readonly day: string;
  readonly label: string;
  readonly events: readonly TimelineEvent[];
};

function utcDayKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Buckets an already-sorted (oldest first) spine by UTC calendar day,
 * preserving that order across day boundaries. */
export function groupTimelineByDay(
  events: readonly TimelineEvent[],
): readonly TimelineDayGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const key = utcDayKey(event.at);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(event);
  }
  return order.map((key) => ({
    day: key,
    label: dayLabel(key),
    events: buckets.get(key) as TimelineEvent[],
  }));
}

export type TimelineDayKpi = {
  readonly day: string;
  readonly label: string;
  readonly messages: number;
  readonly agentTurns: number;
  readonly routineRuns: number;
  readonly approvals: number;
};

/** The right rail's per-day KPI list — counts only, computed straight off
 * the merged spine so it can never disagree with what's rendered. */
export function computeTimelineDayKpis(
  events: readonly TimelineEvent[],
): readonly TimelineDayKpi[] {
  return groupTimelineByDay(events).map((group) => {
    let messages = 0;
    let agentTurns = 0;
    let routineRuns = 0;
    let approvals = 0;
    for (const event of group.events) {
      switch (event.kind) {
        case "message":
          messages += 1;
          if (event.isAgent) agentTurns += 1;
          break;
        case "routine-run":
          routineRuns += 1;
          break;
        case "approval":
          approvals += 1;
          break;
        case "thread-fork":
        case "task":
          break;
      }
    }
    return { day: group.day, label: group.label, messages, agentTurns, routineRuns, approvals };
  });
}

export type TimelineFilter = "all" | "messages" | "runs" | "approvals";

export function filterTimelineEvents(
  events: readonly TimelineEvent[],
  filter: TimelineFilter,
): readonly TimelineEvent[] {
  switch (filter) {
    case "all":
      return events;
    case "messages":
      return events.filter(
        (event) => event.kind === "message" || event.kind === "thread-fork",
      );
    case "runs":
      return events.filter(
        (event) => event.kind === "routine-run" || event.kind === "task",
      );
    case "approvals":
      return events.filter((event) => event.kind === "approval");
  }
}
