// Resolves to the workbench's own tenant (`WorkbenchWire.tenancy`), reusing
// the same cached workbench rows the sidebar already fetches, rather than a
// bespoke endpoint.

import type { Workbench } from "@/chat";

export type WorkbenchInsightsResolution =
  | { readonly kind: "not-found" }
  | { readonly kind: "legacy" }
  | {
      readonly kind: "ready";
      readonly tenantId: string;
      readonly title: string;
    };

/** "not-found" for a stale/mis-typed link; "legacy" for a workbench minted
 * before workbench tenancy existed (`tenancy` is `null`). */
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
