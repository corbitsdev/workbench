// The roster: who is working, who needs you, who is idle. Create lives in
// the sidebar's "+" menu.

import { useState } from "react";
import { Button, RichEmptyState, Skeleton } from "@corbits/react-ui";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@corbits/react-ui/ui/menu";
import { Hash, Plus, Robot } from "@/lib/icons";
import { useQueryClient } from "@tanstack/react-query";

import { AgentRedeployer } from "../agent-redeployer";
import { redeployMode, workerState } from "@/chat/deployment-liveness";
import type { ChatAgent } from "@/chat/threads-api";
import { WorkbenchAvatar } from "@/chat/avatar";
import { useRestartAgent } from "../use-restart-agent";
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
import "./workers-page.css";

export type WorkerTone = "working" | "ready" | "idle";

/** What a worker is doing right now, from its deployment alone: coming up
 * (including a dead one about to be redeployed) is working, stopped is
 * waiting on the person to restart it, live and waiting for mail is idle. */
export function workerStatus(agent: Pick<ChatAgent, "liveAddress" | "latest" | "capped">): {
  readonly tone: WorkerTone;
  readonly text: string;
} {
  switch (workerState(agent)) {
    case "live":
      return { tone: "idle", text: "Waiting for mail" };
    case "stopped":
      return { tone: "ready", text: "Stopped. Restart it to put it back to work." };
    case "starting":
      return { tone: "working", text: "Starting up" };
  }
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
    <span className={tone === "idle" ? "worker-pill worker-pill-idle" : "worker-pill"}>
      <span aria-hidden className="worker-pill-dot" />
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

export function WorkersRosterList({ workers }: { readonly workers: readonly BenchWorker[] }) {
  const [filter, setFilter] = useState<WorkerTone | "all">("all");
  const [query, setQuery] = useState("");
  const restart = useRestartAgent();
  const autoRedeploy = workers.filter(({ agent }) => redeployMode(agent) === "auto");
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
      {autoRedeploy.map(({ agent, bench }) => (
        <AgentRedeployer key={agent.id} workbenchTenantId={bench.id} agent={agent} />
      ))}
      <div className="roster-toolbar">
        <div role="tablist" aria-label="Filter by status" className="bi-seg roster-filter">
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
              <span className="roster-filter-count">
                {rows.filter((row) => key === "all" || row.status.tone === key).length}
              </span>
            </button>
          ))}
        </div>
        <span className="roster-toolbar-spacer" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter workers"
          aria-label="Filter workers"
          className="roster-search"
        />
      </div>
      <div className="roster-row roster-head">
        <span>Worker</span>
        <span>Right now</span>
        <span>Workbench</span>
        <span className="roster-cell-end">Active</span>
      </div>
      {shown.length === 0 ? (
        <p className="roster-empty">No workers match “{query.trim()}”.</p>
      ) : (
        <ul className="roster-list">
          {shown.map(({ agent, bench, status }) => (
            <li key={agent.id} className="roster-row roster-item">
              <Link
                to={workerPath(agent.id)}
                aria-label={agent.name}
                className="roster-item-link"
              />
              <span className="roster-worker">
                <WorkbenchAvatar kind="worker" name={agent.name} size="lg" status={status.tone} />
                <span className="roster-worker-text">
                  <span className="roster-worker-name">{agent.name}</span>
                  <WorkerRole tenantId={bench.id} agent={agent} className="roster-worker-role" />
                </span>
              </span>
              <span className="roster-status">
                <StatusPill tone={status.tone} />
                <span className="roster-status-text">
                  {status.text}
                  <span className="roster-status-bench"> · {bench.name}</span>
                </span>
                {status.tone === "ready" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="roster-restart"
                    disabled={restart.isPending}
                    onClick={() => restart.mutate({ tenantId: bench.id, agent })}
                  >
                    {restart.isPending && restart.variables?.agent.id === agent.id
                      ? "Starting…"
                      : "Restart"}
                  </Button>
                ) : null}
              </span>
              <span className="roster-bench-cell">
                <span className="roster-bench-chip">
                  <Hash className="roster-bench-icon" />
                  <span className="roster-ellipsis">{bench.name}</span>
                </span>
              </span>
              <span className="roster-cell-end roster-active">
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
    <div className="page-frame">
      <StageTopBar crumbs={[{ label: "Workers" }]} />
      <div className="page-scroll-auto">
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
                <p role="alert" className="roster-empty roster-empty-error">
                  {error}
                </p>
              ) : loading ? (
                <Skeleton className="skeleton-panel" />
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
