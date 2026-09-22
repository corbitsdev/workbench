// A workbench is a child tenant, so listing workbenches lists children
// over the stock tenant routes.

import { createFetchStockHub, findOwnedTenants } from "../needs-converge";

export type Workbench = {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  /** A workbench IS its tenant, so every row links to itself. */
  readonly tenancy?: { readonly tenantId: string } | null;
  readonly lastActivityAt?: string;
};

/** Shared by every workbench-listing surface so one create invalidates
 * them all. */
export function workbenchesQueryKeyPrefix(tenantId: string): readonly unknown[] {
  return ["tenant", tenantId, "workbenches"];
}

export function workbenchesQueryKey(tenantId: string): readonly unknown[] {
  return [...workbenchesQueryKeyPrefix(tenantId)];
}

export async function listWorkbenchTenants(tenantId: string): Promise<readonly Workbench[]> {
  const tenants = await findOwnedTenants(createFetchStockHub());
  return tenants
    .filter((tenant) => tenant.parentId === tenantId)
    .map((tenant) => ({
      id: tenant.id,
      title: tenant.name,
      slug: tenant.slug,
      tenancy: { tenantId: tenant.id },
    }));
}

/** The one workbench listing: the bench's child tenants. (Standalone chats
 * used to share this module behind a `kind` parameter; they were removed,
 * so this is a thin wrapper kept for the shared query-key prefix.) */
export async function listWorkbenches(tenantId: string): Promise<readonly Workbench[]> {
  return listWorkbenchTenants(tenantId);
}
