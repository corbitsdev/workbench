import type { TimelineEntry } from "@workbench/client";
import { deepLinkPath } from "@workbench/shared";
import { humanizeToken, parseToolResource } from "./activity-naming";

/** A cross-link to another entity's own trace/detail surface. */
export interface EntityLink {
  to: string;
  label: string;
}

/**
 * Cross-link a timeline moment to the entity's own trace/detail surface, when
 * one exists on real data today.
 */
export function entityLinkForEntry(entry: TimelineEntry): EntityLink | null {
  if (entry.kind === "workflow_run") {
    return {
      to: deepLinkPath("workflow_trace", entry.id),
      label: "Open run trace",
    };
  }
  if (entry.kind === "artifact") {
    return {
      to: deepLinkPath("artifact", entry.id),
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

export interface ParsedGrant {
  resource: string;
  action: string;
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
  const origin = parts.length >= 4 ? (parts[parts.length - 2] ?? null) : null;
  return { resource, action, origin, effect };
}

export function grantEffect(entry: TimelineEntry): GrantEffect {
  return parseGrant(entry).effect;
}

export function grantOrigin(entry: TimelineEntry): string | null {
  return parseGrant(entry).origin;
}

export function grantResourceLabel(resource: string): string {
  const tool = parseToolResource(resource);
  if (tool !== null) {
    return `${humanizeToken(tool.factory)} · ${humanizeToken(tool.name)}`;
  }
  return humanizeToken(resource);
}

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

export type TraceEntityType =
  | "artifact"
  | "workflow_run"
  | "principal"
  | "session"
  | "mail";

export type TraceEntityRef = {
  type: TraceEntityType;
  id: string;
  label?: string;
};

export function entityLink(ref: TraceEntityRef): string {
  switch (ref.type) {
    case "artifact":
      return deepLinkPath("artifact", ref.id);
    case "workflow_run":
      return deepLinkPath("workflow_trace", ref.id);
    case "principal":
      return `/insights/users/${encodeURIComponent(ref.id)}`;
    case "session":
      return deepLinkPath("conversation", ref.id);
    case "mail":
      return deepLinkPath("mail", ref.id);
    default: {
      const _exhaustive: never = ref.type;
      return _exhaustive;
    }
  }
}

export function entityLabel(ref: TraceEntityRef): string {
  if (ref.label) return ref.label;
  switch (ref.type) {
    case "artifact":
      return "Artifact";
    case "workflow_run":
      return "Workflow run";
    case "principal":
      return "Principal";
    case "session":
      return "Session";
    case "mail":
      return "Mail";
    default: {
      const _exhaustive: never = ref.type;
      return _exhaustive;
    }
  }
}