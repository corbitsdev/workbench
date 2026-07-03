import type { TimelineEntry } from "@workbench/client";

/** A cross-link to another entity's own trace/detail surface. */
export interface EntityLink {
  to: string;
  label: string;
}

/**
 * Cross-link a timeline moment to the entity's own trace/detail surface, when
 * one exists on real data today.
 *
 * Everything entity-shaped should be clickable, but a link is only honest when
 * the entry's `id` maps to a real route:
 * - `workflow_run` — the entry `id` IS the run-record id (see the timeline
 *   registry: `workflow_run_record.id`), so it deep-links to that run's trace.
 * - `artifact` — the entry `id` is the artifact primary key, matching
 *   `/artifacts/:artifactId`.
 *
 * An `artifact_version` entry carries the version id (not the artifact id) and
 * the timeline row exposes no artifact id, so we never guess a route for it —
 * likewise for kinds (session, tool_call, grant, …) that have no dedicated
 * destination page yet. Those render as plain references, never a dead link.
 */
export function entityLinkForEntry(entry: TimelineEntry): EntityLink | null {
  if (entry.kind === "workflow_run") {
    return {
      to: `/insights/trace/${encodeURIComponent(entry.id)}`,
      label: "Open run trace",
    };
  }
  if (entry.kind === "artifact") {
    return {
      to: `/artifacts/${encodeURIComponent(entry.id)}`,
      label: "Open artifact",
    };
  }
  return null;
}

export type GrantEffect = "allowed" | "blocked" | "needs-approval" | "unknown";

/** Plain-language, compliance-facing label for each grant effect. */
export const GRANT_EFFECT_LABEL: Record<GrantEffect, string> = {
  allowed: "Allowed",
  blocked: "Blocked",
  "needs-approval": "Needs approval",
  unknown: "Effect not recorded",
};

/**
 * A grant summary is `<resource> <action> <effect>` (see the timeline registry:
 * `grant.resource || ' ' || grant.action || ' ' || grant.effect`), so the
 * trailing token is the effect. Mapped to a plain-language effect. Never
 * inferred for a non-grant entry — the effect vocabulary only means anything on
 * a grant row.
 */
export function grantEffect(entry: TimelineEntry): GrantEffect {
  if (entry.kind !== "grant") return "unknown";
  const effect = (entry.summary ?? "").trim().split(/\s+/).pop() ?? "";
  if (effect === "allow") return "allowed";
  if (effect === "deny") return "blocked";
  if (effect === "ask") return "needs-approval";
  return "unknown";
}

/**
 * Human span between two ISO timestamps, or null when it cannot be trusted:
 * either boundary missing, or a non-finite/negative span (we never invent a
 * duration the record model does not support).
 */
export function formatElapsedBetween(
  fromIso: string | undefined,
  toIso: string | undefined,
): string | null {
  if (fromIso === undefined || toIso === undefined) return null;
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}
