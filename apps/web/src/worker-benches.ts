// Every bench's workers. A worker lives in its bench's own tenant, so the
// roster is the union of the benches' agents, each under its stored name.

import { useQueries } from "@tanstack/react-query";

import { isDefaultWorker, listChatAgents, type ChatAgent } from "@/chat/threads-api";
import { DEFAULT_WORKER_NAME, useWorkerNames } from "./bench/worker-name";
import { tenantKeys } from "./query-client";
import { useBench } from "./bench-context";
import type { HubTenant } from "./needs-converge";
import { useSidebarSections } from "./shell/sidebar-sections";

export type BenchWorker = { readonly agent: ChatAgent; readonly bench: HubTenant };

export type BenchWorkers = {
  readonly workers: readonly BenchWorker[];
  /** True until the benches and their agents have first loaded. */
  readonly loading: boolean;
  readonly error: string | undefined;
};

const RESTART_POLL_MS = 3000;

export function useBenchWorkers(): BenchWorkers {
  const { selectedTenantId } = useBench();
  const sections = useSidebarSections(selectedTenantId);
  const benches = sections.kind === "ready" ? sections.workbenches : [];
  const agents = useQueries({
    queries: benches.map((bench) => ({
      queryKey: tenantKeys.agents(bench.id),
      queryFn: () => listChatAgents(bench.id),
      // Keep polling while a worker is not live, so a restart landing is
      // seen without a reload.
      refetchInterval: (query: { state: { data: readonly ChatAgent[] | undefined } }) =>
        (query.state.data ?? []).some((agent) => agent.liveAddress === null)
          ? RESTART_POLL_MS
          : false,
    })),
  });
  const names = useWorkerNames(benches.map((bench) => bench.id));

  const workers = benches.flatMap((bench, index) =>
    (agents[index]?.data ?? []).map((agent) => ({
      bench,
      agent: isDefaultWorker(agent)
        ? { ...agent, name: names.get(bench.id) ?? DEFAULT_WORKER_NAME }
        : agent,
    })),
  );
  return {
    workers,
    loading: sections.kind === "loading" || agents.some((query) => query.isPending),
    error: sections.kind === "error" ? sections.message : undefined,
  };
}
