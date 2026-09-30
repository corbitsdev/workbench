// The roster: who is working, who needs you, who is idle. Create lives in
// the sidebar's "+" menu.

import { useState } from "react";
import { Button, RichEmptyState, toast } from "@corbits/react-ui";
import { Plus, Robot } from "@/lib/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { QueryView } from "@/lib/api-query";
import { tenantKeys } from "../query-client";
import { isAgentNotRunning, listChatAgents, type ChatAgent } from "@/chat/threads-api";
import { WorkbenchAvatar } from "@/chat/avatar";
import { describeRestartFailure, redeployWorkbenchAgent } from "../workbench-create";
import { useBench } from "../bench-context";
import { useWorkerBenches } from "../worker-benches";
import { Link } from "../navigation";
import { useTenantQuery } from "../routines-api";
import { PageLayout } from "../shell/page-layout";
import { StageTopBar } from "../shell/stage-top-bar";
import { CreateAgentPanel } from "./create-agent-panel";
import { WORKERS_PATH_PREFIX } from "../path-ids";

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

export function WorkersRosterList({
  tenantId,
  agents,
}: {
  readonly tenantId: string;
  readonly agents: readonly ChatAgent[];
}) {
  const { byWorker } = useWorkerBenches();
  const [filter, setFilter] = useState<WorkerTone | "all">("all");
  const [query, setQuery] = useState("");
  const queryClient = useQueryClient();
  const restart = useMutation({
    mutationFn: (agent: ChatAgent) => redeployWorkbenchAgent(tenantId, agent),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: tenantKeys.agents(tenantId),
      });
    },
    onError: (cause) => {
      reportError(cause, { operation: "agent_restart", tenantId });
      toast(describeRestartFailure(cause));
    },
  });
  if (agents.length === 0) {
    return (
      <RichEmptyState
        icon={<Robot />}
        title="No workers yet"
        description="Create one with New worker and it appears here."
      />
    );
  }
  const rows = agents.map((agent) => ({ agent, status: workerStatus(agent) }));
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
          {shown.map(({ agent, status }) => (
            <li key={agent.id} className={`${ROW_GRID} relative px-3 py-3 hover:bg-(--hover)`}>
              <Link
                to={workerPath(agent.id)}
                aria-label={agent.name}
                className="absolute inset-0"
              />
              <span className="flex min-w-0 items-center gap-3">
                <WorkbenchAvatar kind="worker" name={agent.name} size={40} status={status.tone} />
                <span className="min-w-0 text-[14.5px] font-extrabold">{agent.name}</span>
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
                    onClick={() => restart.mutate(agent)}
                  >
                    {restart.isPending && restart.variables?.id === agent.id
                      ? "Starting…"
                      : "Restart"}
                  </Button>
                ) : null}
              </span>
              <span className="flex min-w-0 flex-wrap gap-x-2 text-[12.5px] font-semibold text-(--ink-2)">
                {(byWorker.get(agent.id) ?? []).map((bench) => (
                  <span key={bench.id} className="max-w-full truncate">
                    {bench.name}
                  </span>
                ))}
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
  const agentsQuery = useTenantQuery(
    tenantKeys.agents(selectedTenantId ?? "none"),
    selectedTenantId !== null,
    () => listChatAgents(selectedTenantId as string),
    // Keep polling while any worker is not live, so a restart landing is
    // seen without a reload.
    (agents) => ((agents?.some((agent) => agent.liveAddress === null) ?? false) ? 3000 : false),
  );
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar crumbs={[{ label: "Workers" }]} />
      <div className="min-h-0 flex-1 overflow-auto">
        <PageLayout
          title="Workers"
          subtitle="Each worker picks a name, keeps its memory, and asks before it writes anywhere."
          actions={
            selectedTenantId === null ? undefined : (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus /> New worker
              </Button>
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
              <QueryView query={agentsQuery} label="your workers" skeleton="rows">
                {(agents) => <WorkersRosterList tenantId={selectedTenantId} agents={agents} />}
              </QueryView>
              <CreateAgentPanel
                open={createOpen}
                onOpenChange={setCreateOpen}
                tenantId={selectedTenantId}
                onCreated={() => {
                  void queryClient.invalidateQueries({
                    queryKey: tenantKeys.agents(selectedTenantId),
                  });
                }}
              />
            </>
          )}
        </PageLayout>
      </div>
    </div>
  );
}
