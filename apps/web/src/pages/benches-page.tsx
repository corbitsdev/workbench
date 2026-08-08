// Thin mount of `@corbits/bench-ui`'s workspace: this file only adapts the
// app's bench-selection state (see ../bench-context.tsx) into the shape the
// package expects. All bench management logic — creating a bench, fetching
// members, inviting one — lives in the package.

import { BenchesWorkspace } from "@corbits/bench-ui";
import type { MembershipsResolution } from "@corbits/bench-ui";

import { useBench } from "../bench-context";

export function BenchesRoute() {
  const { memberships, selectedTenantId, selectTenant, onBenchCreated } =
    useBench();

  const resolution: MembershipsResolution =
    memberships.kind === "ready"
      ? { kind: "ready", items: memberships.data.data }
      : memberships.kind === "unauthenticated"
        ? { kind: "error", message: "Sign in to see your benches." }
        : memberships;

  return (
    <BenchesWorkspace
      memberships={resolution}
      selectedTenantId={selectedTenantId}
      onSelectTenant={selectTenant}
      onBenchCreated={(bench) => onBenchCreated(bench.id)}
    />
  );
}
