// A thrown probe (network, 5xx) is `error`, never `denied` — collapsing
// those together made the gated nav vanish as if unauthorized.

import { evaluate } from "./tenancy-api";

export type SectionAccess = "loading" | "allowed" | "denied" | "error";

export type TenancyAccess = {
  readonly people: SectionAccess;
  readonly roles: SectionAccess;
  readonly grants: SectionAccess;
  readonly credentials: SectionAccess;
};

/** Maps one evaluate call to a nav gate. Catch is `error`, not `denied`. */
export async function probeSectionAccess(
  tenantId: string,
  principalId: string,
  resource: string,
): Promise<SectionAccess> {
  try {
    const result = await evaluate(tenantId, principalId, resource, "read");
    return result.effect === "allow" ? "allowed" : "denied";
  } catch {
    // report-error-ignore: a failed evaluate probe is the
    // `error` nav state, not an unexpected exception to report.
    return "error";
  }
}

/** A failed probe must not clobber a prior allow/deny — only an unresolved
 *  gate becomes `error`. That keeps last-known nav and avoids flashing
 *  gated sections that a later successful deny would hide. */
export function coalesceSectionAccess(previous: SectionAccess, next: SectionAccess): SectionAccess {
  if (next === "error" && (previous === "allowed" || previous === "denied")) {
    return previous;
  }
  return next;
}
