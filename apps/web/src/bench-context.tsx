// The one place this app decides which bench is "current": a single fetch of
// `/api/me/principals`, and a selected-tenant id persisted to localStorage so
// the choice survives a reload. Every page that needs to know the current
// bench (the chat page, the benches page, the header switcher) reads this
// context instead of re-deriving "membership[0]" on its own.

import { isRawIdentifier } from "@corbits/bench-ui";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { APIQuery } from "@corbits/api-query";

import { PrincipalsSchema, useAPIQuery } from "./api";
import type { Principal, PrincipalsPage } from "./api";
import { meKeys, tenantKeys } from "./query-client";

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

export type BenchState = {
  readonly memberships: APIQuery<PrincipalsPage>;
  readonly selectedTenantId: string | null;
  readonly selectedPrincipalId: string | null;
  readonly selectTenant: (tenantId: string) => void;
  readonly onBenchCreated: (tenantId: string) => void;
};

/** Exported only so a render test can inject a fixed `BenchState` without
 * standing up `BenchProvider`'s own `/api/me/principals` fetch — every
 * real caller still goes through `useBench`/`BenchProvider`. */
export const BenchContext = createContext<BenchState | null>(null);

/** The membership this context currently treats as selected: the stored
 * choice if it still names a bench the account belongs to, otherwise the
 * first bench-kind membership — the same personal-bench convention
 * `chat-page.tsx` used to apply inline, minus the raw-id tenancies that
 * same unfiltered "first membership" pick let default in.
 *
 * A bench is a membership with a human-assigned name: a tenant whose name
 * is a raw platform id never hosts the shell. The server-side kinds lookup
 * (`POST /api/workbench-tenancies/kinds`) is gone with chat's
 * `workbench_tenancy` table — child-tenant exclusion now lives in the
 * client-held workbench list (`needs-list.ts`'s `childTenantStore`), not in
 * this selector.
 *
 * True for a membership the shell may treat as a bench: named, never raw. */
export function isBenchMembership(membership: Principal): boolean {
  return !isRawIdentifier(membership.tenantName);
}

export function resolveSelection(
  memberships: readonly Principal[],
  stored: string | null,
): Principal | undefined {
  const storedMatch =
    stored !== null
      ? memberships.find((m) => m.tenantId === stored)
      : undefined;
  if (storedMatch !== undefined && isBenchMembership(storedMatch)) {
    return storedMatch;
  }
  return memberships.find((m) => isBenchMembership(m));
}

export function BenchProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient();
  const memberships = useAPIQuery("/api/me/principals", PrincipalsSchema);
  const [stored, setStored] = useState<string | null>(() =>
    readStoredTenantId(),
  );

  const resolved =
    memberships.kind === "ready"
      ? resolveSelection(memberships.data.data, stored)
      : undefined;

  useEffect(() => {
    if (resolved !== undefined && resolved.tenantId !== stored) {
      writeStoredTenantId(resolved.tenantId);
      setStored(resolved.tenantId);
    }
  }, [resolved, stored]);

  const value = useMemo<BenchState>(
    () => ({
      memberships,
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
    [memberships, resolved, stored, queryClient],
  );

  return (
    <BenchContext.Provider value={value}>{children}</BenchContext.Provider>
  );
}

export function useBench(): BenchState {
  const value = useContext(BenchContext);
  if (value === null) {
    throw new Error("useBench used outside BenchProvider");
  }
  return value;
}
