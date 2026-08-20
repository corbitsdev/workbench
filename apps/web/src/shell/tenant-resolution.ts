// Single place that turns the bench context into chat-ui's TenantResolution.
// Chat mounts (main-pane fallback and canvas column) share this so they never
// diverge on empty/loading/ready handling.

import type { TenantResolution } from "@corbits/chat-ui";

import type { useBench } from "../bench-context";

type BenchSlice = Pick<
  ReturnType<typeof useBench>,
  "memberships" | "selectedTenantId"
>;

export function tenantResolutionFromBench(bench: BenchSlice): TenantResolution {
  if (bench.memberships.kind !== "ready") {
    return bench.memberships;
  }
  if (bench.selectedTenantId === null) {
    return { kind: "empty" };
  }
  return { kind: "ready", tenantId: bench.selectedTenantId };
}
