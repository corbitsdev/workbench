// The context object itself, apart from the provider that fills it.
// `createContext` mints a fresh object every time its module runs, and a
// module that also exports a component is a React Refresh boundary that a
// hot update re-executes without re-executing its importers — the provider
// would then publish one context while `useBench` still reads the previous
// one. Holding it in a component-free module keeps a single identity for
// every reader.

import type { APIQuery } from "@/lib/api-query";
import { createContext } from "react";

import type { PrincipalsPage } from "./api";

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
