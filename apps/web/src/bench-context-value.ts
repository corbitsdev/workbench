// Held in a component-free module, since a module with a component is a
// React Refresh boundary — a hot re-execution would mint a new context the
// provider publishes while `useBench` still reads the old one.

import type { APIQuery } from "@/lib/api-query";
import { createContext } from "react";

import type { Principal, PrincipalsPage } from "./api";

export type BenchState = {
  readonly memberships: APIQuery<PrincipalsPage>;
  /** Top-level tenants only; every consumer reads this instead of filtering
   * `memberships` itself, so a workbench can't sneak into a bench list. */
  readonly benchMemberships: readonly Principal[];
  readonly selectedTenantId: string | null;
  readonly selectedPrincipalId: string | null;
  readonly selectTenant: (tenantId: string) => void;
  readonly onBenchCreated: (tenantId: string) => void;
};

/** Exported only so a render test can inject a fixed `BenchState` without
 * standing up `BenchProvider`'s own `/api/me/principals` fetch — every
 * real caller still goes through `useBench`/`BenchProvider`. */
export const BenchContext = createContext<BenchState | null>(null);
