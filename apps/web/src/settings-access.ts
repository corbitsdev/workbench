// Settings section-nav gating, deduplicated: col2's nav band and the
// settings stage both mount independently and both need the same five
// tenancy probes (People/Roles/Grants/Credentials/Memory). Riding the app's shared
// QueryClient — instead of each mount calling `@corbits/settings-ui`'s bare
// `useTenancyAccess`, which fetches on every mount with no cache — means
// two mounted consumers share one in-flight request and one cached result.
// The package stays free of TanStack Query: this only injects its own
// `evaluate` primitive into the app's cache, the package never imports it.

import { evaluate } from "@corbits/settings-ui";
import type { SectionAccess, TenancyAccess } from "@corbits/settings-ui";
import { useQuery } from "@tanstack/react-query";

import { tenantKeys } from "./query-client";

async function probe(
  tenantId: string,
  principalId: string,
  resource: string,
): Promise<SectionAccess> {
  try {
    const result = await evaluate(tenantId, principalId, resource, "read");
    return result.effect === "allow" ? "allowed" : "denied";
  } catch {
    return "denied";
  }
}

const LOADING_ACCESS: TenancyAccess = {
  people: "loading",
  roles: "loading",
  grants: "loading",
  credentials: "loading",
  memory: "loading",
};

/** One shared probe per (tenant, principal), not one per mounted consumer.
 * `null` ids report `loading` — the same "not shown yet, never disabled"
 * contract `@corbits/settings-ui`'s own hook holds. */
export function useSettingsAccess(
  tenantId: string | null,
  principalId: string | null,
): TenancyAccess {
  const enabled = tenantId !== null && principalId !== null;
  const query = useQuery({
    queryKey:
      tenantId !== null && principalId !== null
        ? tenantKeys.settingsAccess(tenantId, principalId)
        : tenantKeys.settingsAccess("none", "none"),
    queryFn: async (): Promise<TenancyAccess> => {
      if (tenantId === null || principalId === null) return LOADING_ACCESS;
      const [people, roles, grants, credentials, memory] = await Promise.all([
        probe(tenantId, principalId, "principal"),
        probe(tenantId, principalId, "role"),
        probe(tenantId, principalId, "grant"),
        probe(tenantId, principalId, "credential"),
        probe(tenantId, principalId, "memory"),
      ]);
      return { people, roles, grants, credentials, memory };
    },
    enabled,
  });

  return query.data ?? LOADING_ACCESS;
}
