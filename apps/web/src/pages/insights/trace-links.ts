import type { TimelineEntry } from "@workbench/client";
import { humanizeToken, parseToolResource } from "./activity-naming";

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
 * The canonical, single-source parse of a grant timeline summary. The summary
 * is `<resource> <action> <origin> <effect>` (see the timeline registry) —
 * origin is optional so a legacy `<resource> <action> <effect>` row still
 * parses. The effect is ALWAYS the trailing token; the resource is ALWAYS the
 * first. Every grant-facing surface (Grants facet, moment decomposition,
 * activity headline) reads grants through this one function so they can never
 * disagree — the bug this replaces was two hand-rolled parses reporting
 * different effects for the same row when the action token was empty.
 */
export interface ParsedGrant {
  resource: string;
  action: string;
  /** Raw origin token (system/role/creator/invoker), or null if not recorded. */
  origin: string | null;
  effect: GrantEffect;
}

function effectFromToken(token: string): GrantEffect {
  if (token === "allow") return "allowed";
  if (token === "deny") return "blocked";
  if (token === "ask") return "needs-approval";
  return "unknown";
}

export function parseGrant(entry: TimelineEntry): ParsedGrant {
  if (entry.kind !== "grant") {
    return { resource: "", action: "", origin: null, effect: "unknown" };
  }
  const parts = (entry.summary ?? "").trim().split(/\s+/).filter(Boolean);
  const resource = parts[0] ?? "";
  const action = parts[1] ?? "";
  const effect = effectFromToken(parts[parts.length - 1] ?? "");
  // origin sits between action and effect — present only on 4-token rows.
  const origin = parts.length >= 4 ? (parts[parts.length - 2] ?? null) : null;
  return { resource, action, origin, effect };
}

/**
 * Plain-language, compliance-facing effect for a grant row. Never inferred for
 * a non-grant entry — the effect vocabulary only means anything on a grant.
 */
export function grantEffect(entry: TimelineEntry): GrantEffect {
  return parseGrant(entry).effect;
}

/** Raw grant origin token (creator/role/invoker/system), or null. */
export function grantOrigin(entry: TimelineEntry): string | null {
  return parseGrant(entry).origin;
}

/** Humanizes a grant resource id into a plain label (tool-aware). */
export function grantResourceLabel(resource: string): string {
  const tool = parseToolResource(resource);
  if (tool !== null) {
    return `${humanizeToken(tool.factory)} · ${humanizeToken(tool.name)}`;
  }
  return humanizeToken(resource);
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
