// The one place this app decides which bench is "current": a single fetch of
// `/api/me/principals`, and a selected-tenant id persisted to localStorage so
// the choice survives a reload. Every page that needs to know the current
// bench (the chat page, the benches page, the header switcher) reads this
// context instead of re-deriving "membership[0]" on its own.

import {
  classifyBenchMembership,
  listChannelTenantIds,
} from "@corbits/bench-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

const BenchContext = createContext<BenchState | null>(null);

/** The membership this context currently treats as selected: the stored
 * choice if it still names a bench the account belongs to *and* still
 * classifies as a workbench, otherwise the first workbench-kind
 * membership — the same personal-bench convention `chat-page.tsx` used
 * to apply inline, minus the channel and raw-id tenancies that same
 * unfiltered "first membership" pick let default in.
 *
 * `channelTenantIds` may still be empty because the kinds lookup
 * hasn't resolved yet — never blocks boot on it (`isRawIdentifier`
 * inside `classifyBenchMembership` catches a raw-id tenant with no
 * fetch at all). A stored selection that was picked before the fetch
 * resolved, and turns out to be a channel, is re-evaluated on every
 * call, so the default self-corrects once `channelTenantIds` arrives
 * rather than sticking with whatever `resolveSelection` picked first. */
export function resolveSelection(
  memberships: readonly Principal[],
  stored: string | null,
  channelTenantIds: ReadonlySet<string>,
): Principal | undefined {
  const storedMatch =
    stored !== null
      ? memberships.find((m) => m.tenantId === stored)
      : undefined;
  if (
    storedMatch !== undefined &&
    classifyBenchMembership(storedMatch, channelTenantIds) === "workbench"
  ) {
    return storedMatch;
  }
  return memberships.find(
    (m) => classifyBenchMembership(m, channelTenantIds) === "workbench",
  );
}

export function BenchProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient();
  const memberships = useAPIQuery("/api/me/principals", PrincipalsSchema);
  const [stored, setStored] = useState<string | null>(() =>
    readStoredTenantId(),
  );

  const tenantIds =
    memberships.kind === "ready"
      ? memberships.data.data.map((membership) => membership.tenantId)
      : [];
  // Never gates boot: `resolveSelection` below runs against `new Set()`
  // until this resolves, catching only the raw-id case immediately —
  // the channel case self-corrects once `channelTenancyKinds.data` lands
  // and this component re-renders.
  const channelTenancyKinds = useQuery({
    queryKey: meKeys.channelTenancyKinds(tenantIds),
    queryFn: () => listChannelTenantIds(tenantIds),
    enabled: tenantIds.length > 0,
  });

  const resolved =
    memberships.kind === "ready"
      ? resolveSelection(
          memberships.data.data,
          stored,
          channelTenancyKinds.data ?? new Set(),
        )
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
