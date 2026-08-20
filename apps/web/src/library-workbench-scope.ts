// Files' workbench-first lens (CL-6353): resolves the "current workbench"
// pill to that workbench's own tenant, the same `tenancy.tenantId`
// `insights-workbench-scope.ts` scopes Insights on — never the workbench id
// itself and never the bench's root tenant.

import type { Workbench } from "@corbits/chat-ui";

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
