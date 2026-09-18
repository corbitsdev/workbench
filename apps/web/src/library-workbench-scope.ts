// Resolves to the workbench's own tenant id, same as
// `insights-workbench-scope.ts` — never the bench's root tenant.

import type { Workbench } from "@/chat";

export type LibraryWorkbenchScope = {
  readonly tenantId: string;
  readonly title: string;
};

/** `workbenchId` → the workbench's own tenant + title, or `null` when it
 * isn't in view (a stale signal from a since-deleted workbench) or is a
 * true legacy workbench with no tenancy of its own. */
export function resolveLibraryWorkbenchScope(
  workbenches: readonly Workbench[],
  workbenchId: string | null,
): LibraryWorkbenchScope | null {
  if (workbenchId === null) return null;
  const workbench = workbenches.find((w) => w.id === workbenchId);
  if (workbench === undefined) return null;
  if (workbench.tenancy === undefined || workbench.tenancy === null) {
    return null;
  }
  return { tenantId: workbench.tenancy.tenantId, title: workbench.title };
}
