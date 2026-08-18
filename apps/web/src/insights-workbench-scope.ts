// Insights is scoped per workbench (CL-5879): `/insights/workbench/:workbenchId`
// resolves to that workbench's OWN workbench tenant — every workbench minted
// through POST /workbenches carries a tenancy link (see `WorkbenchWire.tenancy`
// in @corbits/chat-ui) — never the workbench id itself and never the bench's
// root tenant. Both directions of that lookup (a workbench id in the URL
// resolving to a tenant id; a tenant id off a usage row resolving back to
// the workbench that opens it) go through these two pure functions over the
// SAME cached workbench rows the shell's sidebar already fetched, rather
// than a bespoke reverse-lookup endpoint.

import type { Workbench } from "@corbits/chat-ui";

export type WorkbenchInsightsResolution =
  | { readonly kind: "not-found" }
  | { readonly kind: "legacy" }
  | {
      readonly kind: "ready";
      readonly tenantId: string;
      readonly title: string;
    };

/** `workbenchId` → this workbench's own workbench tenant, or an honest reason
 * there isn't one: absent from the bench's workbench list at all ("not-found"
 * — the only path a stale `/insights/workbench/:tenantId` link or a
 * mis-typed id can take now that route is retired), or a true legacy
 * workbench minted before workbench tenancy existed ("legacy", `tenancy` is
 * `null`). */
export function resolveWorkbenchInsightsScope(
  workbenches: readonly Workbench[],
  workbenchId: string,
): WorkbenchInsightsResolution {
  const workbench = workbenches.find((c) => c.id === workbenchId);
  if (workbench === undefined) return { kind: "not-found" };
  if (workbench.tenancy === undefined || workbench.tenancy === null) {
    return { kind: "legacy" };
  }
  return {
    kind: "ready",
    tenantId: workbench.tenancy.tenantId,
    title: workbench.title,
  };
}

/** The reverse lookup: a workbench usage row only carries the workbench's
 * tenant id (see `WorkbenchUsage` in `./insights-api`) — this finds the
 * workbench that opens it, for the "activity by workbench" rows and the
 * scope switcher's sibling pills. Null when no workbench in view carries
 * that tenancy (shouldn't happen for a same-bench sibling, but never
 * invents a link). */
export function workbenchIdForWorkbenchTenant(
  workbenches: readonly Workbench[],
  tenantId: string,
): string | null {
  return (
    workbenches.find(
      (c) =>
        c.tenancy !== undefined &&
        c.tenancy !== null &&
        c.tenancy.tenantId === tenantId,
    )?.id ?? null
  );
}
