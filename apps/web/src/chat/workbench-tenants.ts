// A workbench is a child tenant, so listing workbenches is listing the
// bench's children over the stock tenant routes. This is the whole
// workbench-listing surface the rest of the app reads — the workbench itself
// lives in the child tenant's mailbox (`threads-api.ts`).

import { createFetchStockHub, findOwnedTenants } from "../needs-converge";
import { listChats } from "./threads-api";

export type WorkbenchKind = "workbench" | "chat";

export type Workbench = {
  readonly id: string;
  readonly title: string;
  readonly kind: WorkbenchKind;
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

export function workbenchesQueryKey(tenantId: string, kind: WorkbenchKind): readonly unknown[] {
  return [...workbenchesQueryKeyPrefix(tenantId), kind];
}

export async function listWorkbenchTenants(tenantId: string): Promise<readonly Workbench[]> {
  const tenants = await findOwnedTenants(createFetchStockHub());
  return tenants
    .filter((tenant) => tenant.parentId === tenantId)
    .map((tenant) => ({
      id: tenant.id,
      title: tenant.name,
      kind: "workbench" as const,
      slug: tenant.slug,
      tenancy: { tenantId: tenant.id },
    }));
}

/** The two listing surfaces behind one call: workbenches are the bench's
 * child tenants, chats are the person's own mail threads. */
export async function listWorkbenches(
  tenantId: string,
  kind: WorkbenchKind,
): Promise<readonly Workbench[]> {
  if (kind === "workbench") return listWorkbenchTenants(tenantId);
  const chats = await listChats(tenantId);
  return chats.map((chat) => ({
    id: chat.id,
    title: chat.title,
    kind: "chat" as const,
    slug: chat.id,
    tenancy: { tenantId },
    lastActivityAt: chat.lastActivityAt,
  }));
}
