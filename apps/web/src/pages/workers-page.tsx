// The roster: who is working, who needs you, who is idle. Create lives in
// the sidebar's "+" menu.

import { useState } from "react";
import { Button, RichEmptyState, Skeleton } from "@corbits/react-ui";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@corbits/react-ui/ui/menu";
import { toast } from "@corbits/react-ui/ui/toast";
import { Plus, Robot } from "@/lib/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { tenantKeys } from "../query-client";
import { isAgentNotRunning, type ChatAgent } from "@/chat/threads-api";
import { WorkbenchAvatar } from "@/chat/avatar";
import { describeRestartFailure, redeployWorkbenchAgent } from "../workbench-create";
import { useBench } from "../bench-context";
import type { HubTenant } from "../needs-converge";
import { useSidebarSections } from "../shell/sidebar-sections";
import { useBenchWorkers, type BenchWorker } from "../worker-benches";
import { Link, useNavigate } from "../navigation";
import { PageLayout } from "../shell/page-layout";
import { StageTopBar } from "../shell/stage-top-bar";
import { CreateAgentPanel } from "./create-agent-panel";
import { WORKERS_PATH_PREFIX } from "../path-ids";
import { NEW_WORKBENCH_PATH } from "../routes";
import { useWorkerRole } from "../worker-role-query";

export type WorkerTone = "working" | "ready" | "idle";

/** What a worker is doing right now, from its deployment alone: coming up is
 * working, stopped is waiting on the person to restart it, live and waiting
 * for mail is idle. */
export function workerStatus(agent: Pick<ChatAgent, "liveAddress" | "latestStatus">): {
  readonly tone: WorkerTone;
  readonly text: string;
} {
  if (agent.liveAddress !== null) return { tone: "idle", text: "Waiting for mail" };
  return isAgentNotRunning(agent)
    ? { tone: "ready", text: "Stopped. Restart it to put it back to work." }
    : { tone: "working", text: "Starting up" };
}

export function workerPath(agentId: string): string {
  return `${WORKERS_PATH_PREFIX}/${encodeURIComponent(agentId)}`;
}

const PILL_LABEL: Record<WorkerTone, string> = {
  working: "Working",
  ready: "Needs you",
  idle: "Idle",
};

export function WorkerRole({
  tenantId,
  agent,
  className,
}: {
  readonly tenantId: string;
  readonly agent: ChatAgent;
  readonly className?: string;
}) {
  return <p className={className}>{useWorkerRole(tenantId, agent)}</p>;
}

export function StatusPill({ tone }: { readonly tone: WorkerTone }) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-[12px] font-bold ${
        tone === "idle" ? "bg-(--hover) text-(--ink-3)" : "bg-(--attention-wash) text-(--ink)"
      }`}
    >
      {PILL_LABEL[tone]}
    </span>
  );
}

const FILTERS: readonly (readonly [WorkerTone | "all", string])[] = [
  ["all", "All"],
  ["working", "Working"],
  ["ready", "Needs you"],
  ["idle", "Idle"],
];

const ROW_GRID =
  "grid items-center gap-4 md:grid-cols-[minmax(200px,1.2fr)_minmax(220px,1.6fr)_minmax(120px,1fr)_72px]";

export function WorkersRosterList({ workers }: { readonly workers: readonly BenchWorker[] }) {
  const [filter, setFilter] = useState<WorkerTone | "all">("all");
  const [query, setQuery] = useState("");
  const queryClient = useQueryClient();
  const restart = useMutation({
    mutationFn: ({ agent, bench }: BenchWorker) => redeployWorkbenchAgent(bench.id, agent),
    onSuccess: (_result, { bench }) => {
      void queryClient.invalidateQueries({
        queryKey: tenantKeys.agents(bench.id),
      });
    },
    onError: (cause, { bench }) => {
      reportError(cause, { operation: "agent_restart", tenantId: bench.id });
      toast(describeRestartFailure(cause));
    },
  });
  if (workers.length === 0) {
    return (
      <RichEmptyState
        icon={<Robot />}
        title="No workers yet"
        description="Create one with New worker and it appears here."
      />
    );
  }
  const rows = workers.map((worker) => ({ ...worker, status: workerStatus(worker.agent) }));
  const needle = query.trim().toLowerCase();
  const shown = rows.filter(
    ({ agent, status }) =>
      (filter === "all" || status.tone === filter) &&
      `${agent.name} ${status.text}`.toLowerCase().includes(needle),
  );
  return (
    <div>
      <div className="mb-3 flex flex-col items-stretch gap-3 min-[601px]:flex-row min-[601px]:items-center">
        <div
          role="tablist"
          aria-label="Filter by status"
          className="bi-seg max-w-full overflow-x-auto whitespace-nowrap [&_button]:shrink-0"
        >
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={filter === key ? "active" : undefined}
              onClick={() => setFilter(key)}
            >
              {label}{" "}
              <span className="tabular-nums opacity-60">
                {rows.filter((row) => key === "all" || row.status.tone === key).length}
              </span>
            </button>
          ))}
        </div>
        <span className="hidden flex-1 min-[601px]:block" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter workers"
          aria-label="Filter workers"
          className="h-8 w-full min-[601px]:w-56 rounded-(--r-md) border border-(--line) bg-(--card) px-3 text-[13px]"
        />
      </div>
      <div className={`${ROW_GRID} hidden px-3 pb-2 text-[12px] font-bold text-(--ink-3) md:grid`}>
        <span>Worker</span>
        <span>Right now</span>
        <span>Workbench</span>
        <span className="text-right">Active</span>
      </div>
      {shown.length === 0 ? (
        <p className="py-12 text-center text-[14px] text-(--ink-3)">
          No workers match this filter.
        </p>
      ) : (
        <ul className="divide-y divide-(--line) border-y border-(--line)">
          {shown.map(({ agent, bench, status }) => (
            <li key={agent.id} className={`${ROW_GRID} relative px-3 py-3 hover:bg-(--hover)`}>
              <Link
                to={workerPath(agent.id)}
                aria-label={agent.name}
                className="absolute inset-0"
              />
              <span className="flex min-w-0 items-center gap-3">
                <WorkbenchAvatar kind="worker" name={agent.name} size="lg" status={status.tone} />
                <span className="min-w-0">
                  <span className="block text-[14.5px] font-extrabold">{agent.name}</span>
                  <WorkerRole
                    tenantId={bench.id}
                    agent={agent}
                    className="truncate text-[12.5px] text-(--ink-3)"
                  />
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-2.5 text-[13.5px]">
                <StatusPill tone={status.tone} />
                <span className="truncate">{status.text}</span>
                {status.tone === "ready" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="relative"
                    disabled={restart.isPending}
                    onClick={() => restart.mutate({ agent, bench })}
                  >
                    {restart.isPending && restart.variables?.agent.id === agent.id
                      ? "Starting…"
                      : "Restart"}
                  </Button>
                ) : null}
              </span>
              <span className="flex min-w-0 flex-wrap gap-x-2 text-[12.5px] font-semibold text-(--ink-2)">
                <span className="max-w-full truncate">{bench.name}</span>
              </span>
              <span className="text-right text-[12.5px] text-(--ink-3)">
                {agent.liveAddress === null ? "" : "Now"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WorkersRoute() {
  const { selectedTenantId } = useBench();
  const { workers, loading, error } = useBenchWorkers();
  const sections = useSidebarSections(selectedTenantId);
  const benches = sections.kind === "ready" ? sections.workbenches : [];
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [createBench, setCreateBench] = useState<HubTenant | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar crumbs={[{ label: "Workers" }]} />
      <div className="min-h-0 flex-1 overflow-auto">
        <PageLayout
          title="Workers"
          subtitle="Each worker picks a name, keeps its memory, and asks before it writes anywhere."
          actions={
            selectedTenantId === null || sections.kind !== "ready" ? undefined : benches.length ===
              0 ? (
              <Button size="sm" onClick={() => navigate(NEW_WORKBENCH_PATH)}>
                <Plus /> New worker
              </Button>
            ) : benches.length === 1 ? (
              <Button size="sm" onClick={() => setCreateBench(benches[0] ?? null)}>
                <Plus /> New worker
              </Button>
            ) : (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="sm">
                    <Plus /> New worker
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  {benches.map((bench) => (
                    <MenuItem key={bench.id} onSelect={() => setCreateBench(bench)}>
                      {bench.name}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            )
          }
        >
          {selectedTenantId === null ? (
            <RichEmptyState
              icon={<Robot />}
              title="Select a workbench"
              description="Pick a workbench from the switcher to see its workers."
            />
          ) : (
            <>
              {error !== undefined ? (
                <p role="alert" className="py-12 text-center text-[14px] text-(--danger-ink)">
                  {error}
                </p>
              ) : loading ? (
                <Skeleton className="h-40 w-full" />
              ) : (
                <WorkersRosterList workers={workers} />
              )}
              {createBench === null ? null : (
                <CreateAgentPanel
                  open
                  onOpenChange={(open) => {
                    if (!open) setCreateBench(null);
                  }}
                  tenantId={createBench.id}
                  onCreated={() => {
                    // Prefix key: the roster and the sidebar's agent reads.
                    void queryClient.invalidateQueries({
                      queryKey: ["tenant", createBench.id, "agents"],
                    });
                  }}
                />
              )}
            </>
          )}
        </PageLayout>
      </div>
    </div>
  );
}
