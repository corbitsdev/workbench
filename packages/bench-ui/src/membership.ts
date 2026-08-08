// Pure helpers for the bench surface: slug derivation, and the display-name
// mapping that keeps a raw platform identifier from ever reaching the
// screen. No fetching, no React — bare functions bun:test can hit directly.

import { BENCH_STRINGS } from "./strings";
import type { BenchMember, BenchMembership } from "./api";

/** Every platform id prefix this UI must never render verbatim. Mirrors the
 * same floor `packages/chat-ui` enforces over its own fixture surface. */
const RAW_ID_PATTERN = /\b(prn_|ins_|tnt_|role_|grant_)[a-z0-9]/i;

/**
 * A lowercase-kebab slug derived from a bench name, e.g. "Launch Team!" →
 * "launch-team". Empty or entirely-punctuation input has no derivable slug,
 * so callers see an empty string and can hold the create action disabled
 * rather than submit a slug of dashes.
 */
export function deriveBenchSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Whether the create-bench form has enough to submit: a name with a
 * derivable, non-empty slug. */
export function canCreateBench(name: string): boolean {
  return deriveBenchSlug(name).length > 0;
}

/** A membership's bench name, and its roles joined for display. Both fields
 * of `PrincipalSummary` are already server-resolved, human-facing strings —
 * this just picks the shape the switcher and the memberships table want. */
export function membershipDisplay(membership: BenchMembership): {
  readonly tenantId: string;
  readonly name: string;
  readonly roleLabel: string;
} {
  return {
    tenantId: membership.tenantId,
    name: membership.tenantName,
    roleLabel:
      membership.roles.length === 0
        ? BENCH_STRINGS.memberRoleNone
        : membership.roles.map((role) => role.name).join(", "),
  };
}

/**
 * A member's display name, guarded against the one native gap this surface
 * works around: `PrincipalResponse.displayName` falls back server-side to
 * the principal's raw `refId` whenever identity resolution finds nothing
 * (today, that is any `kind: "agent"` principal — see
 * `resolveIdentities` in vendor/intx/hub-api/src/routes/principals.ts,
 * which only resolves `user` and `workflow` kinds). Rather than let a raw
 * id slip onto the member list, this recognizes the shape and substitutes
 * friendly placeholder copy.
 */
export function memberDisplayName(member: BenchMember): string {
  return RAW_ID_PATTERN.test(member.displayName)
    ? BENCH_STRINGS.memberUnnamed
    : member.displayName;
}

export function memberRoleLabel(member: BenchMember): string {
  return member.roles.length === 0
    ? BENCH_STRINGS.memberRoleNone
    : member.roles.map((role) => role.name).join(", ");
}
