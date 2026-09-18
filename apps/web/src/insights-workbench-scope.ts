// Insights is scoped per workbench: `/insights/workbench/:workbenchId`
// resolves to that workbench's OWN workbench tenant — every workbench minted
// through POST /workbenches carries a tenancy link (see `WorkbenchWire.tenancy`
// in @/chat) — never the workbench id itself and never the bench's
// root tenant. That lookup goes through this one pure function over the SAME
// cached workbench rows the shell's sidebar already fetches, rather than a
// bespoke endpoint. deleted the reverse lookup
// (`workbenchIdForWorkbenchTenant`): it only served the cross-workbench
// "activity by workbench" chart and scope switcher, both dropped along with
// packages/insights.

import type { Workbench } from "@/chat";

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
