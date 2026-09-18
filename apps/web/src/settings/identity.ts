// An agent principal's `displayName` falls back server-side to a raw
// `refId`; the UI floor forbids showing that raw value, so this derives a
// humane stand-in and keeps the raw value for a tooltip only.

import { SETTINGS_STRINGS } from "./strings";

export const PRINCIPAL_KIND_ORDER = ["user", "agent", "workflow"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KIND_ORDER)[number];

export const PRINCIPAL_KIND_LABEL: Record<PrincipalKind, string> = {
  user: SETTINGS_STRINGS.peopleKindUser,
  agent: SETTINGS_STRINGS.peopleKindAgent,
  workflow: SETTINGS_STRINGS.peopleKindWorkflow,
};

const RAW_LOOKING_PATTERN = /^[a-z]+_[a-z0-9-]{6,}$|:\/\/|@/i;

function looksRaw(value: string): boolean {
  return RAW_LOOKING_PATTERN.test(value);
}

// Falls back to "Unnamed agent" when nothing recognizable survives.
function derivePrincipalLabel(raw: string): string {
  const segment =
    raw
      .split(/[/@]/)
      .filter((part) => part.length > 0)
      .pop() ?? raw;
  const cleaned = segment
    .replace(/^[a-z]+_/i, "")
    .replace(/[-_.()]+/g, " ")
    .trim();
  if (cleaned.length === 0) return "Unnamed agent";
  return cleaned
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export type PrincipalLabel = {
  /** What a person reads. Never the raw identifier. */
  readonly label: string;
  /** The raw identifier the label was derived from, for a tooltip only —
   * `null` when `displayName` was already humane and nothing was derived. */
  readonly raw: string | null;
};

export function principalLabel(displayName: string): PrincipalLabel {
  if (!looksRaw(displayName)) return { label: displayName, raw: null };
  return { label: derivePrincipalLabel(displayName), raw: displayName };
}
