// Pure helpers for the People section's one identity gap: `PrincipalResponse`
// gives agent principals no identity resolution, so `displayName` falls back
// server-side to the raw `refId` (see `resolveIdentities` in
// vendor/intx/hub-api/src/routes/principals.ts). The UI floor forbids ever
// showing that raw value as the label a person reads — this derives a
// humane stand-in from it and keeps the raw value available for a tooltip
// only, never as visible text.
//
// `PRINCIPAL_KIND_LABEL` and `PRINCIPAL_KIND_ORDER` live here too, shared by
// every picker that lists principals (Grants' target select and filter,
// Roles' assignment select): Grants/Roles assign to people, agents, *and*
// workflows (see `people-section.tsx`'s own header comment), and a picker
// that shows only names with no kind is kind-blind — a workflow's machine
// principal can look identical to a person's account. Every such picker
// must show which kind an option is, not just its name.

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

/**
 * Strips the plumbing off a raw agent address or id — scheme, host,
 * underscore-prefixed type tags — down to whatever's left of a human name,
 * title-cased. Falls back to a plain "Unnamed agent" when nothing
 * recognizable survives.
 */
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
