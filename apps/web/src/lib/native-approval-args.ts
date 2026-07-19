// Structured, humanized rendering of a gated tool call's arguments for the
// approval card (CL-3942). The old inline "key: v · key: v · +N more" string was
// cramped and hid fields; this derives a clean labeled key/value row list the
// card renders vertically. Pure + framework-free so it is unit-testable.

import { toHumanLabel } from "@workbench/ui";

/** How a value should be presented. */
export type ApprovalArgValueKind =
  | "text" // short scalar, render inline
  | "long" // long text (description/body) — clamp + expand
  | "id" // an opaque identifier — monospace + truncate
  | "list"; // an array rendered as a readable member list / count

export type ApprovalArgRow = {
  key: string;
  label: string;
  /** The presentation string (already humanized where cheaply possible). */
  display: string;
  kind: ApprovalArgValueKind;
};

/** Explicit key → human label overrides; unknown keys fall back to a
 * title-cased key with a trailing "Id" stripped ("assigneeId" → "Assignee"). */
const KEY_LABELS: Record<string, string> = {
  title: "Title",
  name: "Name",
  subject: "Subject",
  teamId: "Team",
  team: "Team",
  priority: "Priority",
  description: "Description",
  body: "Body",
  message: "Message",
  content: "Content",
  assigneeId: "Assignee",
  projectId: "Project",
  stateId: "State",
  labelIds: "Labels",
  channel: "Channel",
  to: "To",
  cc: "Cc",
  url: "URL",
};

/** Humanize an argument key into a display label. */
export function humanizeArgKey(key: string): string {
  const explicit = KEY_LABELS[key];
  if (explicit !== undefined) return explicit;
  const stripped = key.endsWith("Id") ? key.slice(0, -2) : key;
  return toHumanLabel(stripped);
}

/** Linear's numeric priority convention. Applied only for Linear tools. */
const LINEAR_PRIORITY: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

function isLinearTool(toolName: string): boolean {
  return toolName.toLowerCase().startsWith("linear");
}

/** Keys whose value is an opaque identifier we should not render as bare text. */
const ID_KEYS = new Set([
  "teamId",
  "team",
  "assigneeId",
  "projectId",
  "stateId",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Truncate an opaque id so a 36-char UUID never dominates the card. */
export function truncateId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…`;
}

const LONG_TEXT_KEYS = new Set(["description", "body", "content", "message"]);
const LONG_TEXT_CHARS = 120;

/** Resolve an opaque id (e.g. a Linear teamId) to a human name from
 * already-loaded client data. Returns null when unresolvable. */
export type IdResolver = (key: string, rawValue: string) => string | null;

function scalarToString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function renderArray(value: unknown[]): string | null {
  if (value.length === 0) return null;
  const items = value
    .map(scalarToString)
    .filter((item): item is string => item !== null);
  if (items.length === value.length && items.length <= 6) {
    const joined = items.join(", ");
    if (joined.length <= 120) return joined;
  }
  return `${value.length} items`;
}

function rowFor(
  toolName: string,
  key: string,
  value: unknown,
  resolveId: IdResolver | undefined,
): ApprovalArgRow | null {
  const label = humanizeArgKey(key);

  if (Array.isArray(value)) {
    const display = renderArray(value);
    return display === null ? null : { key, label, display, kind: "list" };
  }

  if (
    key === "priority" &&
    typeof value === "number" &&
    isLinearTool(toolName)
  ) {
    const mapped = LINEAR_PRIORITY[value];
    return {
      key,
      label,
      display: mapped ?? String(value),
      kind: "text",
    };
  }

  const scalar = scalarToString(value);
  if (scalar === null) {
    // Object or empty — render a compact preview of inner scalar fields.
    if (value !== null && typeof value === "object") {
      const inner = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => {
          const s = scalarToString(v);
          return s === null ? null : `${k}: ${s}`;
        })
        .filter((s): s is string => s !== null)
        .slice(0, 2);
      if (inner.length > 0) {
        return { key, label, display: `{ ${inner.join(", ")} }`, kind: "text" };
      }
    }
    return null;
  }

  // Opaque identifier: resolve to a name if we can, else truncate + monospace.
  if (ID_KEYS.has(key) || UUID_RE.test(scalar)) {
    const resolved = resolveId?.(key, scalar) ?? null;
    if (resolved !== null) {
      return { key, label, display: resolved, kind: "text" };
    }
    return { key, label, display: truncateId(scalar), kind: "id" };
  }

  if (LONG_TEXT_KEYS.has(key) && scalar.length > LONG_TEXT_CHARS) {
    return { key, label, display: scalar, kind: "long" };
  }

  return { key, label, display: scalar, kind: "text" };
}

/**
 * Build the ordered, humanized argument rows for an approval card. Nothing is
 * hidden behind a "+N more" cue: every field that carries something showable
 * becomes a row (the card clamps individual long values rather than dropping
 * fields). `resolveId` lets the caller map an opaque id (e.g. a Linear teamId)
 * to a name from already-loaded client data.
 */
export function buildApprovalArgRows(
  toolName: string,
  args: Record<string, unknown>,
  opts?: { resolveId?: IdResolver },
): ApprovalArgRow[] {
  const rows: ApprovalArgRow[] = [];
  for (const [key, value] of Object.entries(args)) {
    const row = rowFor(toolName, key, value, opts?.resolveId);
    if (row !== null) rows.push(row);
  }
  return rows;
}
