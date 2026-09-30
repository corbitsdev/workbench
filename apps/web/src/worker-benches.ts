// Which benches each worker runs in. A bench deploys its own copy of a
// worker, with a new asset id but the same deploy-source asset name (the
// slug is carried into the name), so the workspace worker joins to each
// bench's copy by asset name, never by display name.

import { useQueries, useQuery } from "@tanstack/react-query";

import { isDefaultWorker, listChatAgents, type ChatAgent } from "@/chat/threads-api";
import { DEFAULT_WORKER_NAME, useWorkerNames } from "./bench/worker-name";
import { tenantKeys } from "./query-client";
import { useBench } from "./bench-context";
import type { HubTenant } from "./needs-converge";
import { useSidebarSections } from "./shell/sidebar-sections";

export type WorkerBenches = {
  /** Workspace worker id -> the benches running a copy of it. */
  readonly byWorker: ReadonlyMap<string, readonly HubTenant[]>;
  /** The workspace worker id a bench copy (by asset name) stands for. */
  readonly workerIdForAsset: (assetName: string) => string | undefined;
  readonly benches: readonly HubTenant[];
};

export function useWorkerBenches(): WorkerBenches {
  const { selectedTenantId } = useBench();
  const sections = useSidebarSections(selectedTenantId);
  const benches = sections.kind === "ready" ? sections.workbenches : [];

  const workers = useQuery({
    queryKey: tenantKeys.agents(selectedTenantId ?? "none"),
    enabled: selectedTenantId !== null,
    queryFn: () => listChatAgents(selectedTenantId as string),
  });
  const benchAgents = useQueries({
    queries: benches.map((bench) => ({
      queryKey: tenantKeys.agents(bench.id),
      queryFn: () => listChatAgents(bench.id),
    })),
  });

  const workerIdByAsset = new Map((workers.data ?? []).map((w) => [w.assetName, w.id]));
  const byWorker = new Map<string, HubTenant[]>();
  benches.forEach((bench, index) => {
    for (const agent of benchAgents[index]?.data ?? []) {
      const workerId = workerIdByAsset.get(agent.assetName);
      if (workerId === undefined) continue;
      byWorker.set(workerId, [...(byWorker.get(workerId) ?? []), bench]);
    }
  });

  return { byWorker, workerIdForAsset: (assetName) => workerIdByAsset.get(assetName), benches };
}

/** The roster's agents with each bench worker under its bench's stored name
 * (the first bench when a worker runs in several); "New worker" until named. */
export function useNamedAgents(agents: readonly ChatAgent[]): readonly ChatAgent[] {
  const { byWorker } = useWorkerBenches();
  const firstBenchIds = agents.map((agent) => byWorker.get(agent.id)?.[0]?.id ?? "");
  const names = useWorkerNames(firstBenchIds.filter((id) => id !== ""));
  return agents.map((agent, index) =>
    isDefaultWorker(agent)
      ? { ...agent, name: names.get(firstBenchIds[index] ?? "") ?? DEFAULT_WORKER_NAME }
      : agent,
  );
}
