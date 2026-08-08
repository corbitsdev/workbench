// The one place this app decides which bench is "current": a single fetch of
// `/api/me/principals`, and a selected-tenant id persisted to localStorage so
// the choice survives a reload. Every page that needs to know the current
// bench (the chat page, the benches page, the header switcher) reads this
// context instead of re-deriving "membership[0]" on its own.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { PrincipalsSchema, useAPIQuery } from "./api";
import type { APIQuery, Principal, PrincipalsPage } from "./api";

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
 * choice if it still names a bench the account belongs to, otherwise the
 * first membership — the same personal-bench convention `chat-page.tsx`
 * used to apply inline. */
function resolveSelection(
  memberships: readonly Principal[],
  stored: string | null,
): Principal | undefined {
  if (stored !== null) {
    const match = memberships.find((m) => m.tenantId === stored);
    if (match !== undefined) return match;
  }
  return memberships[0];
}

export function BenchProvider({ children }: { readonly children: ReactNode }) {
  const [reloadKey, setReloadKey] = useState(0);
  const memberships = useAPIQuery(
    "/api/me/principals",
    PrincipalsSchema,
    reloadKey,
  );
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
        writeStoredTenantId(tenantId);
        setStored(tenantId);
      },
      onBenchCreated: (tenantId: string) => {
        writeStoredTenantId(tenantId);
        setStored(tenantId);
        setReloadKey((value) => value + 1);
      },
    }),
    [memberships, resolved],
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
