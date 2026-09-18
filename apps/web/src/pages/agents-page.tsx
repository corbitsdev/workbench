// Agents: a roster and nothing else — display name, live/starting status,
// and a Chat action per agent. Everything this page used to carry (a
// detail panel, run health/events/approvals, bulk archive) leaned on hub
// routes or state no longer worth a whole screen; a chat with the agent is
// the one action anyone actually used. Create-agent lives in the sidebar's
// "+" menu, not here.

import {
  Badge,
  Button,
  PageShell,
  RichEmptyState,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@corbits/react-ui";
import { Robot } from "@/lib/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { QueryView } from "@/lib/api-query";
import { chatKeys, chatPath } from "../chat-path";
import { isAgentNotRunning, listChatAgents, type ChatAgent } from "@/chat/threads-api";
import { describeRestartFailure, redeployRoomAgent } from "../workbench-create";
import { useBench } from "../bench-context";
import { Link } from "../navigation";
import { useTenantQuery } from "../routines-api";
import { StageTopBar } from "../shell/stage-top-bar";

/**
 * One agent's roster row: `Live` once it has a live run address, `starting`
 * while a deploy is still landing one (mid-first-deploy or mid-redeploy),
 * `not-running` once its latest deployment has gone terminal (a hub
 * restart releases every prior allocation) — a restart is then the only
 * way forward.
 */
export function agentRosterStatus(
  agent: Pick<ChatAgent, "liveAddress" | "latestStatus">,
): "live" | "starting" | "not-running" {
  if (agent.liveAddress !== null) return "live";
  return isAgentNotRunning(agent) ? "not-running" : "starting";
}

export function AgentsRosterList({
  tenantId,
  agents,
}: {
  readonly tenantId: string;
  readonly agents: readonly ChatAgent[];
}) {
  const queryClient = useQueryClient();
  const restart = useMutation({
    mutationFn: (agent: ChatAgent) => redeployRoomAgent(tenantId, agent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.agents(tenantId) });
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
        title="No agents yet"
        description="Create an agent — a name and a system prompt — from the + menu, and it appears here."
      />
    );
  }
  return (
    <Table aria-label="Agents">
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-1" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent) => {
          const status = agentRosterStatus(agent);
          return (
            <TableRow key={agent.id}>
              <TableCell className="font-medium">
                <span className="text-[13.5px] font-bold">{agent.name}</span>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5">
                  {status === "live" ? (
                    <StatusDot label="Live" live tone="emphasis" size="xs" />
                  ) : null}
                  <Badge
                    tone={
                      status === "live"
                        ? "success"
                        : status === "not-running"
                          ? "warning"
                          : "neutral"
                    }
                    className="normal-case"
                  >
                    {status === "live"
                      ? "Live"
                      : restart.isPending && restart.variables?.id === agent.id
                        ? "Starting…"
                        : status === "not-running"
                          ? "Not running"
                          : "Starting"}
                  </Badge>
                </span>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-2">
                  {status === "not-running" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restart.isPending}
                      onClick={() => restart.mutate(agent)}
                    >
                      Restart
                    </Button>
                  ) : null}
                  <Button asChild variant="outline" size="sm">
                    <Link to={chatPath(agent.id)}>Chat</Link>
                  </Button>
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function AgentsRoute() {
  const { selectedTenantId } = useBench();
  const agentsQuery = useTenantQuery(
    chatKeys.agents(selectedTenantId ?? "none"),
    selectedTenantId !== null,
    () => listChatAgents(selectedTenantId as string),
    // Keep polling while any agent is not live, so a released→deployed
    // (or a restart landing) transition is seen without a reload.
    (agents) => ((agents?.some((agent) => agent.liveAddress === null) ?? false) ? 3000 : false),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Agents" }]}
        subtitle="Every agent this workbench can chat with."
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <PageShell width="full" className="page-fill">
          {selectedTenantId === null ? (
            <RichEmptyState
              icon={<Robot />}
              title="Select a workbench"
              description="Pick a workbench from the switcher to see the agents it can chat with."
            />
          ) : (
            <div className="px-4 pb-5 sm:px-7">
              <QueryView query={agentsQuery} label="your agents" skeleton="rows">
                {(agents) => <AgentsRosterList tenantId={selectedTenantId} agents={agents} />}
              </QueryView>
            </div>
          )}
        </PageShell>
      </div>
    </div>
  );
}
