// The one place this app decides which bench is "current": a single fetch of
// `/api/me/principals`, and a selected-tenant id persisted to localStorage so
// the choice survives a reload. Every page that needs to know the current
// bench (the chat page, the benches page, the header switcher) reads this
// context instead of re-deriving "membership[0]" on its own.

import {
  classifyBenchMembership,
  listWorkbenchTenantIds,
} from "@corbits/bench-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { reportError } from "@corbits/error-sink";

import type { APIQuery } from "@corbits/api-query";

import { PrincipalsSchema, useAPIQuery } from "./api";
import type { Principal, PrincipalsPage } from "./api";
import { meKeys, tenantKeys } from "./query-client";
import { buildNeedsList } from "./needs-list";
import { convergeNeedsList, createFetchStockHub } from "./needs-converge";
import { MYRA_DEFINITION_REF_ID, resolveMyraDeployBody } from "./myra-deploy";
import type { SessionUser } from "./session";

const STORAGE_KEY = "workbench.selectedTenantId";

/** A lowercase-kebab personal-tenant slug, unique per user without a
 * coordinating registry: the local part of the email plus a short
 * fragment of the user's own id. Mirrors
 * `@workbench/onboarding`'s (server-side) `personalTenantSlug` — kept
 * as its own copy here since this module must stay browser-safe and
 * that package is not. */
function personalTenantSlug(email: string, userId: string): string {
  const local = email.split("@")[0] ?? email;
  const kebab = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = userId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-8)
    .toLowerCase();
  return `${kebab || "bench"}-${suffix || "personal"}`;
}

function defaultPrimaryTenantName(user: SessionUser): string {
  const source =
    user.name.trim().length > 0 ? user.name.trim() : user.email.split("@")[0];
  return `${source || "Your"}'s team`;
}

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
 * choice if it still names a bench the account belongs to *and* still
 * classifies as a bench, otherwise the first bench-kind
 * membership — the same personal-bench convention `chat-page.tsx` used
 * to apply inline, minus the workbench and raw-id tenancies that same
 * unfiltered "first membership" pick let default in.
 *
 * `workbenchTenantIds` may still be empty because the kinds lookup
 * hasn't resolved yet — never blocks boot on it (`isRawIdentifier`
 * inside `classifyBenchMembership` catches a raw-id tenant with no
 * fetch at all). A stored selection that was picked before the fetch
 * resolved, and turns out to be a workbench, is re-evaluated on every
 * call, so the default self-corrects once `workbenchTenantIds` arrives
 * rather than sticking with whatever `resolveSelection` picked first. */
export function resolveSelection(
  memberships: readonly Principal[],
  stored: string | null,
  workbenchTenantIds: ReadonlySet<string>,
): Principal | undefined {
  const storedMatch =
    stored !== null
      ? memberships.find((m) => m.tenantId === stored)
      : undefined;
  if (
    storedMatch !== undefined &&
    classifyBenchMembership(storedMatch, workbenchTenantIds) === "bench"
  ) {
    return storedMatch;
  }
  return memberships.find(
    (m) => classifyBenchMembership(m, workbenchTenantIds) === "bench",
  );
}

export function BenchProvider({
  children,
  user,
}: {
  readonly children: ReactNode;
  /** Absent only in tests that stand up `BenchProvider` without a full
   * signed-in shell — genesis convergence below simply never fires
   * without one. Every real mount (`Shell` in app.tsx) supplies it. */
  readonly user?: SessionUser;
}) {
  const queryClient = useQueryClient();
  const memberships = useAPIQuery("/api/me/principals", PrincipalsSchema);
  const [stored, setStored] = useState<string | null>(() =>
    readStoredTenantId(),
  );

  // Genesis (CL-8085): a signed-in session with zero memberships anywhere
  // converges its own primary tenant directly, over stock routes — the
  // hub mints, gates, and observes nothing. Runs once per mount per
  // empty-membership observation; a failure is reported and simply
  // leaves membership empty for the next mount/retry to pick up.
  const genesisRanRef = useRef(false);
  useEffect(() => {
    if (user === undefined) return;
    if (memberships.kind !== "ready") return;
    if (memberships.data.data.length > 0) return;
    if (genesisRanRef.current) return;
    genesisRanRef.current = true;
    const manifest = buildNeedsList({
      user: { id: user.id, email: user.email },
      primaryTenant: {
        slug: personalTenantSlug(user.email, user.id),
        name: defaultPrimaryTenantName(user),
      },
      myraDefinitionRefId: MYRA_DEFINITION_REF_ID,
      workbenches: [],
    });
    const hub = createFetchStockHub(fetch, {
      resolveAgentDeploy: resolveMyraDeployBody,
    });
    void convergeNeedsList(manifest, hub)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: meKeys.principals });
      })
      .catch((cause: unknown) => {
        genesisRanRef.current = false;
        reportError(cause, { operation: "needs_list_genesis_converge" });
      });
  }, [memberships, user, queryClient]);

  const tenantIds =
    memberships.kind === "ready"
      ? memberships.data.data.map((membership) => membership.tenantId)
      : [];
  // Never gates boot: `resolveSelection` below runs against `new Set()`
  // until this resolves, catching only the raw-id case immediately —
  // the workbench case self-corrects once `workbenchTenancyKinds.data` lands
  // and this component re-renders.
  const workbenchTenancyKinds = useQuery({
    queryKey: meKeys.workbenchTenancyKinds(tenantIds),
    queryFn: () => listWorkbenchTenantIds(tenantIds),
    enabled: tenantIds.length > 0,
  });

  const resolved =
    memberships.kind === "ready"
      ? resolveSelection(
          memberships.data.data,
          stored,
          workbenchTenancyKinds.data ?? new Set(),
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
        // CL-8085: every bench create converges Myra onto it directly —
        // a stock deploy call, not a server-side kick.
        const hub = createFetchStockHub(fetch, {
          resolveAgentDeploy: resolveMyraDeployBody,
        });
        void hub
          .deployAgent(tenantId, { definitionRefId: MYRA_DEFINITION_REF_ID })
          .catch((cause: unknown) => {
            reportError(cause, {
              operation: "needs_list_bench_create_converge",
              tenantId,
            });
          });
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
