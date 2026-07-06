import type { TimelineEntry } from "@workbench/client";
import { KIND_META } from "./timeline-kinds";

/**
 * Turns raw timeline rows into legible, action-first headlines and groups a
 * burst of related rows into a coherent "turn" (CL-2714).
 *
 * The activity feed was a flat wall of `GRANT` rows like
 * `tool:workflows__workflow_start invoke allow`. A grant is the *permission that
 * allowed an action*, not the activity — so we name the ACTION it enabled, and
 * cluster a session's rows (the grants it exercised, the tools it ran, the
 * result) into one connected flow instead of a undifferentiated list.
 */

export interface EntryDescription {
  /** Action-first headline, e.g. "Allowed: Start workflow". */
  headline: string;
  /** Secondary context, or null. */
  detail: string | null;
}

/** snake/kebab/`__`-delimited token → Sentence case words. */
export function humanizeToken(token: string): string {
  const words = token
    .replace(/__/g, " ")
    .replace(/[_:/-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return token;
  return words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase(),
    )
    .join(" ");
}

interface ParsedToolResource {
  factory: string;
  name: string;
}

/** Parses a `tool:<factory>__<name>` grant resource, or null if not a tool. */
export function parseToolResource(resource: string): ParsedToolResource | null {
  if (!resource.startsWith("tool:")) return null;
  const rest = resource.slice("tool:".length);
  const sep = rest.indexOf("__");
  if (sep === -1) return { factory: rest, name: rest };
  return { factory: rest.slice(0, sep), name: rest.slice(sep + 2) };
}

/**
 * Grant verb, three-valued from the effect token so the headline never
 * contradicts the effect badge (GRANT_EFFECT_LABEL in trace-links): a
 * needs-approval grant must not read as denied, and an unrecorded/unknown
 * effect must fall back to a neutral, non-denial phrasing — never "Blocked".
 */
function grantVerb(effect: string): string {
  if (effect === "allow") return "Allowed";
  if (effect === "deny") return "Blocked";
  if (effect === "ask") return "Needs approval";
  return "Permission checked";
}

function describeGrant(summary: string): EntryDescription {
  const parts = summary.trim().split(/\s+/);
  const resource = parts[0] ?? "";
  const effect = parts[parts.length - 1] ?? "";
  const verb = grantVerb(effect);

  const tool = parseToolResource(resource);
  if (tool !== null) {
    return {
      headline: `${verb}: ${humanizeToken(tool.name)}`,
      detail: `${humanizeToken(tool.factory)} tool`,
    };
  }
  if (resource === "") {
    return { headline: `${verb} an action`, detail: null };
  }
  return { headline: `${verb}: ${humanizeToken(resource)}`, detail: null };
}

function describeToolCall(summary: string | null): EntryDescription {
  if (summary === null || summary.trim() === "") {
    return { headline: "Ran a tool", detail: null };
  }
  return { headline: `Ran ${humanizeToken(summary)}`, detail: null };
}

/**
 * Maps a timeline entry to an action-first headline. Grant rows are re-framed as
 * the action they allowed; tool calls as what ran; everything else keeps its
 * kind label as the headline with the raw summary as detail.
 */
export function describeActivityEntry(entry: TimelineEntry): EntryDescription {
  if (entry.kind === "grant") {
    return describeGrant(entry.summary ?? "");
  }
  if (entry.kind === "tool_call") {
    return describeToolCall(entry.summary);
  }
  return {
    headline: KIND_META[entry.kind].label,
    detail: entry.summary,
  };
}

export interface ActivityTurn {
  id: string;
  startedAt: string;
  endedAt: string;
  entries: TimelineEntry[];
  /** One-line summary of the connected flow. */
  headline: string;
  /** Per-kind counts within the turn, for the flow summary. */
  counts: Record<string, number>;
}

/** Kinds that anchor a turn's headline, most-salient first. */
const ANCHOR_KINDS: TimelineEntry["kind"][] = [
  "workflow_run",
  "artifact",
  "upload",
  "tool_call",
  "message",
  "session",
];

function turnHeadline(entries: TimelineEntry[]): string {
  for (const kind of ANCHOR_KINDS) {
    const anchor = entries.find((e) => e.kind === kind);
    if (anchor !== undefined) return describeActivityEntry(anchor).headline;
  }
  const first = entries[0];
  return first ? describeActivityEntry(first).headline : "Activity";
}

export const DEFAULT_TURN_GAP_MS = 2 * 60_000;

/**
 * Clusters a reverse-chronological entry list into turns: consecutive entries
 * within `gapMs` of each other form one turn (a burst of related activity —
 * a session and the grants/tools it exercised). We have no session id on the
 * timeline rows, so time-adjacency is the grouping signal; the turn's headline
 * is drawn from its most salient anchor entry (a workflow run, an artifact, a
 * tool call…), giving a legible "what happened" line over the raw rows.
 */
export function groupActivityIntoTurns(
  entries: TimelineEntry[],
  gapMs: number = DEFAULT_TURN_GAP_MS,
): ActivityTurn[] {
  if (entries.length === 0) return [];

  const groups: TimelineEntry[][] = [];
  let current: TimelineEntry[] = [];
  let prevTime: number | null = null;

  for (const entry of entries) {
    const t = new Date(entry.timestamp).getTime();
    if (prevTime !== null && Math.abs(prevTime - t) > gapMs) {
      groups.push(current);
      current = [];
    }
    current.push(entry);
    prevTime = t;
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => {
    const counts: Record<string, number> = {};
    for (const e of group) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    const times = group.map((e) => new Date(e.timestamp).getTime());
    const startedAt = new Date(Math.min(...times)).toISOString();
    const endedAt = new Date(Math.max(...times)).toISOString();
    const anchor = group[0];
    return {
      id: anchor ? `${anchor.sourceTable}:${anchor.id}` : startedAt,
      startedAt,
      endedAt,
      entries: group,
      headline: turnHeadline(group),
      counts,
    };
  });
}
