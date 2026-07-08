import { useMemo, useState } from "react";
import {
  useStartWorkflow,
  useWorkflowDeployments,
} from "../hooks/use-workflow";
import {
  dedupeDeployedWorkflows,
  type DeployedWorkflowSummary,
} from "../lib/deployed-workflows";

export interface WorkflowCatalogProps {
  tenantId: string | null;
  runKinds: readonly string[];
  onWorkflowStarted: (runId: string) => void;
}

function WorkflowCard({
  workflow,
  starting,
  disabled,
  onStart,
}: {
  workflow: DeployedWorkflowSummary;
  starting: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  return (
    <div
      data-kind={workflow.kind}
      className="flex flex-col justify-between gap-3 rounded-[10px] border border-border bg-surface p-4 transition-colors hover:bg-[var(--row-hover)]"
    >
      <div className="min-w-0 space-y-1">
        <p className="text-[14px] font-semibold text-text">{workflow.label}</p>
        {workflow.description !== undefined && (
          <p className="text-[12px] leading-snug text-text-3 text-pretty">
            {workflow.description}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onStart}
        className="self-start rounded-[7px] border border-border px-3 py-1 text-[12px] font-semibold text-text-2 transition-colors active:scale-[0.97] disabled:opacity-50 hover:border-orange hover:text-orange"
      >
        {starting ? "Starting…" : "Start"}
      </button>
    </div>
  );
}

function CatalogGroup({
  title,
  workflows,
  startingKind,
  startPending,
  onStart,
}: {
  title: string;
  workflows: DeployedWorkflowSummary[];
  startingKind: string | null;
  startPending: boolean;
  onStart: (kind: string) => void;
}) {
  if (workflows.length === 0) return null;
  return (
    <section aria-label={title}>
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="text-[13px] font-semibold text-text">{title}</h3>
        <span className="text-[12px] text-text-3 tabular-nums">
          {workflows.length}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 @[640px]:grid-cols-2 @[980px]:grid-cols-3">
        {workflows.map((workflow) => (
          <WorkflowCard
            key={workflow.kind}
            workflow={workflow}
            starting={startingKind === workflow.kind}
            disabled={startPending}
            onStart={() => onStart(workflow.kind)}
          />
        ))}
      </div>
    </section>
  );
}

// First-class browse/launch catalog of every deployed workflow kind (CL-2692),
// including tenant-inherited kinds the user has never run. Discovery only — a
// click starts the run immediately (gates collect inputs after start), exactly
// like UnifiedCatalogModal.
export function WorkflowCatalog({
  tenantId,
  runKinds,
  onWorkflowStarted,
}: WorkflowCatalogProps) {
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [redeploying, setRedeploying] = useState(false);

  const { data: workflowDeployments = [], isPending } =
    useWorkflowDeployments(tenantId);
  const startWorkflow = useStartWorkflow(tenantId);

  const deployedWorkflows = useMemo(
    () =>
      dedupeDeployedWorkflows(workflowDeployments).sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
    [workflowDeployments],
  );

  const query = search.trim().toLowerCase();
  const filteredWorkflows = deployedWorkflows.filter(
    (w) =>
      w.label.toLowerCase().includes(query) ||
      w.kind.toLowerCase().includes(query),
  );

  const runKindSet = useMemo(() => new Set(runKinds), [runKinds]);
  const recentlyRun = filteredWorkflows.filter((w) => runKindSet.has(w.kind));
  const neverRun = filteredWorkflows.filter((w) => !runKindSet.has(w.kind));
  const grouped = recentlyRun.length > 0;

  const startingKind = startWorkflow.isPending
    ? (startWorkflow.variables?.kind ?? null)
    : null;

  const handleStart = (kind: string) => {
    if (startWorkflow.isPending) return;
    setError(null);
    setRedeploying(false);
    startWorkflow
      .mutateAsync({
        kind,
        input: {},
        onRedeploying: () => setRedeploying(true),
      })
      .then((res) => onWorkflowStarted(res.runId))
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not start the workflow.",
        );
      })
      .finally(() => setRedeploying(false));
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-text">
          Workflow catalog
        </h2>
        <input
          type="search"
          aria-label="Search workflows"
          placeholder="Search workflows…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-[34px] w-full max-w-[260px] rounded-[9px] border border-border bg-page px-[11px] text-[12.5px] text-text placeholder:text-text-3 focus:border-border-strong focus:outline-none"
        />
      </div>

      {redeploying && (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-text-2">
          Finishing an update — retrying…
        </div>
      )}

      {error && !redeploying && (
        <div className="rounded-lg border border-orange bg-[rgba(233,132,40,0.12)] px-3 py-2 text-[13px] text-orange-deep">
          {error}
        </div>
      )}

      {isPending && (
        <p className="py-4 text-[13px] text-text-3">Loading workflows…</p>
      )}
      {!isPending && deployedWorkflows.length === 0 && (
        <p className="py-4 text-[13px] text-text-3">
          No workflows are available to run in this workbench. Your admin may
          need to deploy workflows or enable them for members.
        </p>
      )}
      {!isPending &&
        deployedWorkflows.length > 0 &&
        filteredWorkflows.length === 0 && (
          <p className="py-4 text-[13px] text-text-3">
            No workflows match your search.
          </p>
        )}

      {grouped ? (
        <>
          <CatalogGroup
            title="Recently run"
            workflows={recentlyRun}
            startingKind={startingKind}
            startPending={startWorkflow.isPending}
            onStart={handleStart}
          />
          <CatalogGroup
            title="More workflows"
            workflows={neverRun}
            startingKind={startingKind}
            startPending={startWorkflow.isPending}
            onStart={handleStart}
          />
        </>
      ) : (
        <CatalogGroup
          title="All workflows"
          workflows={neverRun}
          startingKind={startingKind}
          startPending={startWorkflow.isPending}
          onStart={handleStart}
        />
      )}
    </div>
  );
}
