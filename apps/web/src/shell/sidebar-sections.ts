// The sidebar's workbench section, over stock routes only. Workbenches are
// the bench's own child tenants (stock tenant listing).

import { useQuery } from "@tanstack/react-query";

import { chatKeys } from "../chat-path";
import { createFetchStockHub, findOwnedTenants, type HubTenant } from "../needs-converge";

export type SidebarSections =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly workbenches: readonly HubTenant[];
    };

async function listChildTenants(tenantId: string): Promise<readonly HubTenant[]> {
  const tenants = await findOwnedTenants(createFetchStockHub());
  return tenants.filter((tenant) => tenant.parentId === tenantId);
}

export function useSidebarSections(tenantId: string | null): SidebarSections {
  const key = tenantId ?? "";
  const enabled = tenantId !== null;

  const workbenches = useQuery({
    queryKey: chatKeys.childTenants(key),
    enabled,
    queryFn: () => listChildTenants(key),
  });

  if (tenantId === null) return { kind: "ready", workbenches: [] };
  if (workbenches.isError) {
    const cause: unknown = workbenches.error;
    return { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
  }
  if (workbenches.data === undefined) return { kind: "loading" };
  return { kind: "ready", workbenches: workbenches.data };
}
