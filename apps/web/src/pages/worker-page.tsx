// One worker: its instructions (editable), its model, its tool permissions,
// and the workbench it lives on.

import { useState } from "react";
import { Button, Card, CardDescription, CardTitle, PageShell } from "@corbits/react-ui";
import { toast } from "@corbits/react-ui/ui/toast";
import { reportError } from "@corbits/error-sink";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GrantEffect } from "@intx/types";

import { WorkbenchAvatar } from "@/chat/avatar";
import { isMyraAgent, listChatAgents, type ChatAgent } from "@/chat/threads-api";
import { ChatCircle } from "@/lib/icons";
import { QueryView, describeApiError } from "@/lib/api-query";
import { listTopLevelRuns } from "../agents-api";
import { createGrant, revokeGrant, type Grant } from "../settings/tenancy-api";
import { agentSlugFromSourceAssetName, deployAgentSource } from "../agent-deploy";
import { readAgentMcpHandles, readAgentSource } from "../agent-source-read";
import { readGrantSnapshot, saveGrantSnapshot } from "../worker-grants-carry";
import { TOOL_PREFIX, readWorkerToolGrants, workerToolGrantsKey } from "../worker-tool-grants";
import { useBench } from "../bench-context";
import { Link } from "../navigation";
import { tenantKeys } from "../query-client";
import { useTenantQuery } from "../routines-api";
import { StageTopBar } from "../shell/stage-top-bar";
import { WORKERS_PATH_PREFIX } from "../path-ids";
import { workbenchPath } from "../workbench-path";
import { useWorkerBenches } from "../worker-benches";
import { StatusPill, WorkerRole, workerStatus } from "./workers-page";

function sourceKey(tenantId: string, agentId: string) {
  return [...tenantKeys.agents(tenantId), "source", agentId] as const;
}

function InstructionsCard({
  tenantId,
  agent,
}: {
  readonly tenantId: string;
  readonly agent: ChatAgent;
}) {
  const queryClient = useQueryClient();
  const editable = !isMyraAgent(agent);
  const source = useQuery({
    queryKey: sourceKey(tenantId, agent.id),
    queryFn: () => readAgentSource(tenantId, agent.id, agent.assetName),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const saved = source.data?.systemPrompt ?? "";
  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;

  // Editing means republishing the agent's source and redeploying it, the
  // same pipeline that created it; the stock hub has no in-place prompt edit.
  const save = useMutation({
    mutationFn: async (systemPrompt: string) => {
      const slug = agentSlugFromSourceAssetName(agent.assetName);
      if (slug === null) throw new Error(`${agent.assetName} is not an editable worker`);
      const mcpHandles = await readAgentMcpHandles(tenantId, agent.id, agent.assetName);
      const current = await readWorkerToolGrants(tenantId, agent);
      if (current !== null) {
        saveGrantSnapshot(tenantId, agent.assetName, current.principalId, current.tools);
      }
      await deployAgentSource({
        tenantId,
        input: { name: agent.name, systemPrompt, slug, mcpHandles },
      });
    },
    onSuccess: async () => {
      setDraft(null);
      toast("Instructions saved");
      await queryClient.invalidateQueries({
        queryKey: tenantKeys.agents(tenantId),
      });
    },
    onError: (cause) => {
      reportError(cause, { operation: "worker_instructions_save", tenantId });
      toast(describeApiError(cause, "save these instructions"));
    },
  });

  return (
    <Card className="p-5">
      <CardTitle>Instructions</CardTitle>
      <CardDescription>
        How this worker should behave. It reads these at the start of every run.
      </CardDescription>
      {source.isPending ? (
        <p className="mt-3 text-[13px] text-(--ink-3)">Loading instructions…</p>
      ) : source.isError ? (
        <p role="alert" className="mt-3 text-[13px] text-(--danger-ink)">
          {describeApiError(source.error, "load these instructions")}
        </p>
      ) : (
        <>
          <textarea
            aria-label="Instructions"
            rows={8}
            value={value}
            readOnly={!editable}
            onChange={(event) => setDraft(event.target.value)}
            className="mt-3 w-full resize-y rounded-(--r-md) border border-(--line) bg-(--card) p-3 text-[13.5px] leading-relaxed"
          />
          {editable ? (
            <div className="mt-3 flex items-center gap-3">
              <Button
                size="sm"
                disabled={!dirty || value.trim() === "" || save.isPending}
                onClick={() => save.mutate(value.trim())}
              >
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
              <span className="text-[12.5px] text-(--ink-3)">
                {save.isPending
                  ? "Restarting with the new instructions"
                  : dirty
                    ? "Unsaved changes"
                    : "Saved"}
              </span>
            </div>
          ) : (
            <p className="mt-3 text-[12.5px] text-(--ink-3)">
              Myra's instructions ship with Workbench and can't be edited here.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

const MODES: readonly { readonly effect: GrantEffect; readonly label: string }[] = [
  { effect: "allow", label: "Allow" },
  { effect: "ask", label: "Ask" },
  { effect: "deny", label: "Deny" },
];

function PermissionsCard({
  tenantId,
  agent,
}: {
  readonly tenantId: string;
  readonly agent: ChatAgent;
}) {
  const queryClient = useQueryClient();
  const key = workerToolGrantsKey(tenantId, agent.id);
  // While a redeploy's permissions are waiting for the new run to start,
  // keep looking for its principal.
  const carrying = readGrantSnapshot(tenantId, agent.assetName) !== null;
  const query = useQuery({
    queryKey: key,
    queryFn: () => readWorkerToolGrants(tenantId, agent),
    refetchInterval: carrying ? 5000 : false,
  });

  // Create the new grant before revoking the old one so a failure never
  // leaves the tool ungoverned.
  const setMode = useMutation({
    mutationFn: async (input: {
      readonly principalId: string;
      readonly grant: Grant;
      readonly effect: GrantEffect;
    }) => {
      await createGrant(tenantId, {
        principalId: input.principalId,
        resource: input.grant.resource,
        action: "invoke",
        effect: input.effect,
        origin: "creator",
      });
      await revokeGrant(tenantId, input.grant.id);
    },
    onSuccess: (_data, input) => {
      toast(`${input.grant.resource.slice(TOOL_PREFIX.length)}: ${input.effect}`);
    },
    onError: (cause) => {
      reportError(cause, { operation: "worker_permission_set", tenantId });
      toast(describeApiError(cause, "change this permission"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <Card className="mt-4 p-5">
      <CardTitle>Permissions</CardTitle>
      <CardDescription>
        What it may do without asking. Workbench grants can narrow these, never widen them.
        Permissions carry over when you save new instructions.
      </CardDescription>
      {query.isPending ? (
        <p className="mt-3 text-[13px] text-(--ink-3)">Loading permissions…</p>
      ) : query.isError ? (
        <p role="alert" className="mt-3 text-[13px] text-(--danger-ink)">
          {describeApiError(query.error, "load these permissions")}
        </p>
      ) : query.data === null || query.data.tools.length === 0 ? (
        <p className="mt-3 text-[13px] text-(--ink-3)">
          Permissions appear here once this worker has started its first run.
        </p>
      ) : (
        <div className="mt-3">
          {query.data.tools.map((grant) => {
            const name = grant.resource.slice(TOOL_PREFIX.length);
            const principalId = query.data?.principalId ?? "";
            return (
              <div
                key={grant.id}
                className="grid grid-cols-[1fr_auto] items-center gap-3 border-t border-(--line) py-3 first:border-t-0 first:pt-0"
              >
                <b className="min-w-0 truncate font-mono text-[12.5px] font-normal">{name}</b>
                <div
                  role="radiogroup"
                  aria-label={name}
                  className="inline-flex rounded-(--r-md) bg-(--surface) p-0.5"
                >
                  {MODES.map((mode) => {
                    const active = grant.effect === mode.effect;
                    return (
                      <button
                        key={mode.effect}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={setMode.isPending}
                        onClick={() => {
                          if (!active) setMode.mutate({ principalId, grant, effect: mode.effect });
                        }}
                        className={`h-[26px] rounded-(--r-sm) px-2.5 text-[12.5px] font-semibold ${
                          active ? "bg-(--card) text-(--ink) shadow-sm" : "text-(--ink-3)"
                        }`}
                      >
                        {mode.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function DetailsCard({
  tenantId,
  agent,
}: {
  readonly tenantId: string;
  readonly agent: ChatAgent;
}) {
  const source = useQuery({
    queryKey: sourceKey(tenantId, agent.id),
    queryFn: () => readAgentSource(tenantId, agent.id, agent.assetName),
  });
  const first = source.data?.declaredSources[0];
  const runs = useQuery({
    queryKey: [...tenantKeys.agents(tenantId), "runs", agent.id],
    queryFn: () => listTopLevelRuns(tenantId),
  });
  const own = (runs.data ?? []).filter((run) => agent.addresses.includes(run.address));
  const created = own.map((run) => Date.parse(run.createdAt)).sort((a, b) => a - b)[0];
  return (
    <Card className="p-5">
      <CardTitle className="text-[14px]">Details</CardTitle>
      <dl className="mt-3 grid grid-cols-[90px_1fr] gap-y-2 text-[13.5px]">
        <dt className="text-(--ink-3)">Model</dt>
        <dd>{first === undefined ? "…" : `${first.provider} · ${first.model}`}</dd>
        {created === undefined ? null : (
          <>
            <dt className="text-(--ink-3)">Created</dt>
            <dd>
              {new Date(created).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </dd>
          </>
        )}
        {runs.data === undefined ? null : (
          <>
            <dt className="text-(--ink-3)">Runs</dt>
            <dd className="tabular-nums">{own.length}</dd>
          </>
        )}
      </dl>
    </Card>
  );
}

export function WorkerRoute({ agentId }: { readonly agentId: string }) {
  const { selectedTenantId } = useBench();
  const agentsQuery = useTenantQuery(
    tenantKeys.agents(selectedTenantId ?? "none"),
    selectedTenantId !== null,
    () => listChatAgents(selectedTenantId as string),
  );
  const { byWorker } = useWorkerBenches();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <QueryView query={agentsQuery} label="this worker" skeleton="rows">
        {(agents) => {
          const agent = agents.find((candidate) => candidate.id === agentId);
          if (agent === undefined || selectedTenantId === null) {
            return (
              <>
                <StageTopBar
                  crumbs={[{ label: "Workers", href: WORKERS_PATH_PREFIX }, { label: "Not found" }]}
                />
                <p className="p-7 text-[14px] text-(--ink-3)">
                  This workbench has no worker with that id.
                </p>
              </>
            );
          }
          const status = workerStatus(agent);
          const agentBenches = byWorker.get(agent.id) ?? [];
          const bench = agentBenches[0];
          return (
            <>
              <StageTopBar
                crumbs={[{ label: "Workers", href: WORKERS_PATH_PREFIX }, { label: agent.name }]}
              />
              <div className="min-h-0 flex-1 overflow-auto">
                <PageShell width="full" className="page-fill">
                  <div className="mx-auto w-full max-w-4xl px-4 pb-8 sm:px-7">
                    <div className="mb-6 flex items-center gap-4">
                      <WorkbenchAvatar
                        kind="worker"
                        name={agent.name}
                        size="xl"
                        status={status.tone}
                      />
                      <div className="min-w-0 flex-1">
                        <h1 className="text-[24px] font-extrabold">{agent.name}</h1>
                        <WorkerRole
                          tenantId={selectedTenantId}
                          agent={agent}
                          className="mt-0.5 text-[14px] text-(--ink-2)"
                        />
                        <p className="mt-1 flex items-center gap-2 text-[14px] text-(--ink-2)">
                          <StatusPill tone={status.tone} />
                          {status.text}
                        </p>
                      </div>
                      {bench === undefined ? null : (
                        <Link
                          to={workbenchPath(bench.id)}
                          className="inline-flex h-9 items-center gap-2 rounded-(--r-md) bg-(--primary) px-4 text-[14px] font-bold text-(--primary-foreground)"
                        >
                          <ChatCircle />
                          Open {bench.name}
                        </Link>
                      )}
                    </div>
                    <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
                      <div>
                        <InstructionsCard tenantId={selectedTenantId} agent={agent} />
                        <PermissionsCard tenantId={selectedTenantId} agent={agent} />
                      </div>
                      <aside className="flex flex-col gap-4">
                        <DetailsCard tenantId={selectedTenantId} agent={agent} />
                        <Card className="p-5">
                          <CardTitle className="text-[14px]">Workbench</CardTitle>
                          {agentBenches.length === 0 ? (
                            <p className="mt-2 text-[13.5px] text-(--ink-3)">
                              Not in a workbench yet.
                            </p>
                          ) : (
                            agentBenches.map((item) => (
                              <Link
                                key={item.id}
                                to={workbenchPath(item.id)}
                                className="mt-2 block text-[13.5px] font-semibold underline-offset-2 hover:underline"
                              >
                                {item.name}
                              </Link>
                            ))
                          )}
                        </Card>
                      </aside>
                    </div>
                  </div>
                </PageShell>
              </div>
            </>
          );
        }}
      </QueryView>
    </div>
  );
}
