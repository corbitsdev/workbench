// The one place this app decides which bench is "current": a single fetch of
// `/api/me/principals`, and a selected-tenant id persisted to localStorage so
// the choice survives a reload. Every page that needs to know the current
// bench (the chat page, the benches page, the header switcher) reads this
// context instead of re-deriving "membership[0]" on its own.

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { fetchTenantDetail, PrincipalsSchema, useAPIQuery } from "./api";
import type { Principal } from "./api";
import { BenchContext } from "./bench-context-value";
import type { BenchState } from "./bench-context-value";
import { meKeys, tenantKeys } from "./query-client";

export { BenchContext };
export type { BenchState };

const STORAGE_KEY = "workbench.selectedTenantId";

function readStoredTenantId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredTenantId(tenantId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, tenantId);
  } catch {
    // A private-browsing tab with storage disabled loses persistence, not
    // functionality — the in-memory selection for this session still works.
  }
}

/** True for a membership the shell may treat as a bench: a top-level
 * tenant, i.e. one whose `GET /api/tenants/:id` reports `parentId: null`.
 * Workbenches are named child tenants (`needs-converge.ts`'s `POST /api/tenants
 * { parentId }`), so a name-based heuristic can never tell a workbench from a
 * bench — only the tenant's own parent can. `parentByTenantId` holds
 * `undefined` for a tenant whose detail hasn't loaded yet, which this
 * treats as "not (yet known to be) a bench" rather than guessing. */
export function isBenchMembership(
  membership: Principal,
  parentByTenantId: ReadonlyMap<string, string | null>,
): boolean {
  return parentByTenantId.get(membership.tenantId) === null;
}

/** The membership this context currently treats as selected: the stored
 * choice if it still names a bench the account belongs to, otherwise the
 * first bench membership. */
export function resolveSelection(
  memberships: readonly Principal[],
  stored: string | null,
  parentByTenantId: ReadonlyMap<string, string | null>,
): Principal | undefined {
  const storedMatch = stored !== null ? memberships.find((m) => m.tenantId === stored) : undefined;
  if (storedMatch !== undefined && isBenchMembership(storedMatch, parentByTenantId)) {
    return storedMatch;
  }
  return memberships.find((m) => isBenchMembership(m, parentByTenantId));
}

export function BenchProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient();
  const memberships = useAPIQuery("/api/me/principals", PrincipalsSchema);
  const [stored, setStored] = useState<string | null>(() => readStoredTenantId());

  const membershipTenantIds =
    memberships.kind === "ready" ? memberships.data.data.map((m) => m.tenantId) : [];
  // One `GET /api/tenants/:id` per membership — the only place `parentId`
  // comes from. `useQueries` fans a dynamic list of reads out over stable
  // per-tenant cache entries, shared with any other reader of the same key.
  const tenantDetailResults = useQueries({
    queries: membershipTenantIds.map((tenantId) => ({
      queryKey: tenantKeys.detail(tenantId),
      queryFn: () => fetchTenantDetail(tenantId),
      staleTime: 30_000,
    })),
  });
  // A handful of memberships at most, so this is cheap to rebuild every
  // render rather than chase a stable memo key across two parallel arrays.
  const parentByTenantId = new Map<string, string | null>();
  membershipTenantIds.forEach((tenantId, index) => {
    const detail = tenantDetailResults[index]?.data;
    if (detail !== undefined) parentByTenantId.set(tenantId, detail.parentId ?? null);
  });

  const resolved =
    memberships.kind === "ready"
      ? resolveSelection(memberships.data.data, stored, parentByTenantId)
      : undefined;
  const benchMemberships =
    memberships.kind === "ready"
      ? memberships.data.data.filter((m) => isBenchMembership(m, parentByTenantId))
      : [];

  // The resolved bench is the stored one: written during render so no
  // consumer reads a selection the store disagrees with.
  if (resolved !== undefined && resolved.tenantId !== stored) {
    writeStoredTenantId(resolved.tenantId);
    setStored(resolved.tenantId);
  }

  const value = useMemo<BenchState>(
    () => ({
      memberships,
      benchMemberships,
      selectedTenantId: resolved?.tenantId ?? null,
      selectedPrincipalId: resolved?.principalId ?? null,
      selectTenant: (tenantId: string) => {
        const previous = stored;
        if (previous !== null && previous !== tenantId) {
          // Drop the left-behind bench's cache entirely — do not invalidate
          // (which would refetch for a bench the user is no longer on).
          queryClient.removeQueries({ queryKey: tenantKeys.all(previous) });
        }
        writeStoredTenantId(tenantId);
        setStored(tenantId);
      },
      onBenchCreated: (tenantId: string) => {
        writeStoredTenantId(tenantId);
        setStored(tenantId);
        void queryClient.invalidateQueries({ queryKey: meKeys.principals });
      },
    }),
    [memberships, benchMemberships, resolved, stored, queryClient],
  );

  return <BenchContext.Provider value={value}>{children}</BenchContext.Provider>;
}

export function useBench(): BenchState {
  const value = useContext(BenchContext);
  if (value === null) {
    throw new Error("useBench used outside BenchProvider");
  }
  return value;
}
