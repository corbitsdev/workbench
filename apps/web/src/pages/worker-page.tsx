// One worker: its instructions (editable), its model, its tool permissions,
// and the workbench it lives on.

import { useState } from "react";
import { Button, Skeleton } from "@corbits/react-ui";
import { toast } from "@corbits/react-ui/ui/toast";
import { reportError } from "@corbits/error-sink";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GrantEffect } from "@intx/types";

import { WorkbenchAvatar } from "@/chat/avatar";
import { isDefaultWorker, type ChatAgent } from "@/chat/threads-api";
import { CaretRight, ChatCircle, Hash } from "@/lib/icons";
import { describeApiError } from "@/lib/api-query";
import { ConfirmButton } from "../components/confirm-button";
import { useAPIQuery } from "../api";
import { useApprovalTally } from "../bench/approvals-insights";
import { insightsTopLevelRunsPath, TopLevelRunsSchema } from "../insights-api";
import { PageLayout } from "../shell/page-layout";
import { useWorkerRole } from "../worker-role-query";
import { updateGrant, type Grant } from "../settings/tenancy-api";
import { agentSlugFromSourceAssetName, deployAgentSource } from "../agent-deploy";
import {
  needsAgentRedeployForProviderChange,
  readCurrentOfferingSources,
  redeployAgentForProviderChange,
} from "../agent-model-redeploy";
import { readAgentMcpHandles, readAgentSource } from "../agent-source-read";
import {
  TOOL_PREFIX,
  effectiveToolGrants,
  readWorkerToolGrants,
  toolEffectsToCarry,
  workerToolGrantsKey,
} from "../worker-tool-grants";
import { Link } from "../navigation";
import { tenantKeys } from "../query-client";
import { StageTopBar } from "../shell/stage-top-bar";
import { WORKERS_PATH_PREFIX } from "../path-ids";
import { workbenchPath } from "../workbench-path";
import { useBenchWorkers } from "../worker-benches";
import type { HubTenant } from "../needs-converge";
import { StatusPill, workerStatus } from "./workers-page";

import "./worker-page.css";

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
  const editable = !isDefaultWorker(agent);
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
      await deployAgentSource({
        tenantId,
        input: {
          name: agent.name,
          systemPrompt,
          slug,
          mcpHandles,
          toolEffects: current === null ? [] : toolEffectsToCarry(current.tools),
        },
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
    <section className="wp-card">
      <h2>Instructions</h2>
      <p className="wp-sub">
        How this worker should behave. It reads these at the start of every run.
      </p>
      {source.isPending ? (
        <p className="wp-note">Loading instructions…</p>
      ) : source.isError ? (
        <p role="alert" className="wp-note wp-note-error">
          {describeApiError(source.error, "load these instructions")}
        </p>
      ) : (
        <>
          <textarea
            aria-label="Instructions"
            rows={5}
            value={value}
            readOnly={!editable}
            onChange={(event) => setDraft(event.target.value)}
            className="wp-instructions"
          />
          {editable ? (
            <div className="wp-save-row">
              <Button
                size="sm"
                disabled={!dirty || value.trim() === "" || save.isPending}
                onClick={() => save.mutate(value.trim())}
              >
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
              <span className="wp-hint">
                {save.isPending
                  ? "Restarting with the new instructions"
                  : dirty
                    ? "Unsaved changes"
                    : "Saved"}
              </span>
            </div>
          ) : (
            <p className="wp-note wp-hint">
              The default worker's instructions ship with Workbench and can't be edited here.
            </p>
          )}
        </>
      )}
    </section>
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
  const query = useQuery({
    queryKey: key,
    queryFn: () => readWorkerToolGrants(tenantId, agent),
  });

  // Every row for the tool moves together, so a redeploy's requirement
  // beside the tool's own row can't outrank the choice.
  const setMode = useMutation({
    mutationFn: async (input: {
      readonly grants: readonly Grant[];
      readonly resource: string;
      readonly effect: GrantEffect;
    }) => {
      const rows = input.grants.filter((grant) => grant.resource === input.resource);
      await Promise.all(rows.map((row) => updateGrant(tenantId, row.id, { effect: input.effect })));
    },
    onSuccess: (_data, input) => {
      toast(`${input.resource.slice(TOOL_PREFIX.length)}: ${input.effect}`);
    },
    onError: (cause) => {
      reportError(cause, { operation: "worker_permission_set", tenantId });
      toast(describeApiError(cause, "change this permission"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <section className="wp-card">
      <h2>Permissions</h2>
      <p className="wp-sub">
        What it may do without asking. Workbench grants can narrow these, never widen them.
      </p>
      {query.isPending ? (
        <p className="wp-note">Loading permissions…</p>
      ) : query.isError ? (
        <p role="alert" className="wp-note wp-note-error">
          {describeApiError(query.error, "load these permissions")}
        </p>
      ) : query.data === null || query.data.tools.length === 0 ? (
        <p className="wp-note">
          Permissions appear here once this worker has started its first run.
        </p>
      ) : (
        <div className="wp-perm-list">
          {effectiveToolGrants(query.data.tools).map((grant) => {
            const name = grant.resource.slice(TOOL_PREFIX.length);
            const all = query.data?.tools ?? [];
            return (
              <div key={grant.id} className="wp-perm">
                <b>{name}</b>
                <div role="radiogroup" aria-label={name} className="wp-seg">
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
                          if (!active)
                            setMode.mutate({
                              grants: all,
                              resource: grant.resource,
                              effect: mode.effect,
                            });
                        }}
                        className={active ? "active" : undefined}
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
    </section>
  );
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The worker's own runs, matched by address like the rest of this page. */
function useWorkerRuns(tenantId: string, agent: ChatAgent) {
  const runs = useAPIQuery(insightsTopLevelRunsPath(tenantId), TopLevelRunsSchema);
  const own =
    runs.kind === "ready"
      ? runs.data.data
          .filter((run) => agent.addresses.includes(run.address))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : null;
  return { runs, own };
}

function approvalsLabel(tally: ReturnType<typeof useApprovalTally>): string {
  if (tally.kind === "loading") return "…";
  if (tally.kind === "error") return "Unavailable";
  const { once, always, denied, waiting } = tally.counts;
  return `${once + always + denied + waiting} asked · ${once + always} allowed`;
}

function formatSources(
  sources: readonly { readonly provider: string; readonly model: string }[],
): string {
  return sources.map((source) => `${source.provider} · ${source.model}`).join(", ");
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
  const { own } = useWorkerRuns(tenantId, agent);
  const weekStart = Date.now() - WEEK_MS;
  const thisWeek = (own ?? []).filter((run) => Date.parse(run.createdAt) >= weekStart);
  const tally = useApprovalTally(tenantId, thisWeek.slice(0, 50));
  const created = (own ?? []).map((run) => Date.parse(run.createdAt)).sort((a, b) => a - b)[0];

  // Only agents this pipeline deployed can be re-deployed from here — only
  // they carry a slug to keep the address stable under. The default worker's
  // provider moves are handled where the provider is edited (Settings).
  const queryClient = useQueryClient();
  const redeployable = agentSlugFromSourceAssetName(agent.assetName) !== null;
  const offering = useQuery({
    queryKey: [...tenantKeys.agents(tenantId), "offering"],
    queryFn: () => readCurrentOfferingSources(tenantId),
    enabled: redeployable,
  });
  const declared = source.data?.declaredSources;
  const current = offering.data;
  const providerChanged =
    redeployable &&
    declared !== undefined &&
    current !== undefined &&
    needsAgentRedeployForProviderChange(declared, current);

  // Re-deploying preserves the agent's config (instructions, servers,
  // permissions) — `redeployAgentForProviderChange` carries it over, so the
  // move onto the current provider loses nothing the person set.
  const redeploy = useMutation({
    mutationFn: () => redeployAgentForProviderChange({ tenantId, agent }),
    onSuccess: async () => {
      toast("Worker re-deployed onto the current provider");
      await queryClient.invalidateQueries({ queryKey: tenantKeys.agents(tenantId) });
    },
    onError: (cause) => {
      reportError(cause, { operation: "worker_provider_redeploy", tenantId });
    },
  });

  return (
    <section className="wp-card">
      <h2 className="wp-h2--small">Details</h2>
      <dl className="wp-kv">
        <dt>Model</dt>
        <dd>{first === undefined ? "…" : `${first.provider} · ${first.model}`}</dd>
        {created === undefined ? null : (
          <>
            <dt>Created</dt>
            <dd>
              {new Date(created).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </dd>
          </>
        )}
        {own === null ? null : (
          <>
            <dt>Runs</dt>
            <dd className="wp-figure">{thisWeek.length} this week</dd>
            <dt>Approvals</dt>
            <dd className="wp-figure">{approvalsLabel(tally)}</dd>
          </>
        )}
      </dl>
      {!providerChanged ? null : (
        <div className="wp-redeploy">
          <p className="wp-note">
            The inference provider changed since this worker was deployed — it still runs on{" "}
            {formatSources(declared ?? [])}, while the workspace now offers{" "}
            {formatSources(current ?? [])}. Re-deploying moves it over and keeps its instructions,
            servers, and permissions.
          </p>
          {redeploy.isError ? (
            <p role="alert" className="wp-note wp-note-error">
              {describeApiError(redeploy.error, "re-deploy this worker")}
            </p>
          ) : null}
          <div className="wp-save-row">
            <ConfirmButton
              size="sm"
              disabled={redeploy.isPending}
              confirmLabel={`Re-deploy onto ${formatSources(current ?? [])}`}
              onConfirm={() => redeploy.mutate()}
            >
              {redeploy.isPending ? "Re-deploying…" : "Re-deploy"}
            </ConfirmButton>
            <span className="wp-hint">
              {redeploy.isPending
                ? "Moving onto the current provider"
                : "Re-deploys and restarts this worker"}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function ActivityPanel({
  tenantId,
  agent,
}: {
  readonly tenantId: string;
  readonly agent: ChatAgent;
}) {
  const { runs, own } = useWorkerRuns(tenantId, agent);
  return (
    <section className="wp-card">
      <h2>Activity</h2>
      <p className="wp-sub">Its most recent runs.</p>
      {runs.kind === "loading" ? (
        <Skeleton className="skeleton-card-lg" />
      ) : own === null ? (
        <p className="wp-empty">Couldn't load its runs.</p>
      ) : own.length === 0 ? (
        <p className="wp-empty">No runs yet.</p>
      ) : (
        <div className="wp-runs">
          {own.slice(0, 20).map((run) => (
            <div key={run.id} className="wp-run">
              <b>
                {new Date(run.createdAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </b>
              <span>{run.status}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function MemoryPanel() {
  return (
    <section className="wp-card">
      <h2>Memory</h2>
      <p className="wp-sub">What it has learned to remember between runs.</p>
      <p className="wp-empty">Nothing remembered yet.</p>
    </section>
  );
}

function DangerCard({ name }: { readonly name: string }) {
  return (
    <section className="wp-card wp-danger">
      <div>
        <h2>Delete {name}</h2>
        <p className="wp-sub">
          Stops its schedules and removes it from every workbench. Its artifacts stay.
        </p>
      </div>
      <div className="wp-danger-actions">
        <ConfirmButton
          size="sm"
          disabled
          title="Deleting a worker isn't available yet"
          confirmLabel={`Delete ${name} permanently`}
          onConfirm={() => undefined}
        >
          Delete worker
        </ConfirmButton>
      </div>
    </section>
  );
}

const TABS = ["Overview", "Activity", "Memory"] as const;
type Tab = (typeof TABS)[number];

function WorkerDetail({ agent, bench }: { readonly agent: ChatAgent; readonly bench: HubTenant }) {
  const [tab, setTab] = useState<Tab>("Overview");
  const status = workerStatus(agent);
  const role = useWorkerRole(bench.id, agent);
  return (
    <PageLayout
      title={agent.name}
      subtitle={role}
      leading={<WorkbenchAvatar kind="worker" name={agent.name} size="xl" status={status.tone} />}
      actions={
        <Link to={workbenchPath(bench.id)} className="wp-open">
          <ChatCircle />
          Open {bench.name}
        </Link>
      }
    >
      <nav className="wp-tabs" role="tablist" aria-label="Worker sections">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "active" : undefined}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </nav>
      {tab === "Activity" ? (
        <ActivityPanel tenantId={bench.id} agent={agent} />
      ) : tab === "Memory" ? (
        <MemoryPanel />
      ) : (
        <div className="wp-grid">
          <div className="wp-stack">
            <InstructionsCard tenantId={bench.id} agent={agent} />
            <PermissionsCard tenantId={bench.id} agent={agent} />
            <DangerCard name={agent.name} />
          </div>
          <aside className="wp-stack">
            <section className="wp-card">
              <h2 className="wp-h2--small">Status</h2>
              <div className="wp-status">
                <StatusPill tone={status.tone} />
                <span>{status.text}</span>
              </div>
            </section>
            <DetailsCard tenantId={bench.id} agent={agent} />
            <section className="wp-card">
              <h2 className="wp-h2--small">Workbench</h2>
              <Link to={workbenchPath(bench.id)} className="wp-li">
                <Hash size={14} aria-hidden="true" />
                <b>{bench.name}</b>
                <CaretRight size={14} aria-hidden="true" />
              </Link>
            </section>
          </aside>
        </div>
      )}
    </PageLayout>
  );
}

export function WorkerRoute({ agentId }: { readonly agentId: string }) {
  const { workers, loading, error } = useBenchWorkers();
  const found = workers.find((candidate) => candidate.agent.id === agentId);

  return (
    <div className="page-frame">
      {error !== undefined ? (
        <p role="alert" className="wp-page-message wp-page-message-error">
          {error}
        </p>
      ) : loading ? (
        <Skeleton className="wp-page-skeleton" />
      ) : found === undefined ? (
        <>
          <StageTopBar
            crumbs={[{ label: "Workers", href: WORKERS_PATH_PREFIX }, { label: "Not found" }]}
          />
          <p className="wp-page-message">This workbench has no worker with that id.</p>
        </>
      ) : (
        <>
          <StageTopBar
            crumbs={[{ label: "Workers", href: WORKERS_PATH_PREFIX }, { label: found.agent.name }]}
          />
          <div className="page-scroll-auto">
            <WorkerDetail agent={found.agent} bench={found.bench} />
          </div>
        </>
      )}
    </div>
  );
}
