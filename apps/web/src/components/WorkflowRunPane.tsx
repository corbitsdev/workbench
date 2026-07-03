import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { toHumanLabel } from "@workbench/ui";
import { RunConsole } from "./RunConsole";
import { ErrorBoundary } from "./ErrorBoundary";
import { loadWorkflowUI } from "../lib/workflow-ui";
import { usePublishActiveContext } from "../lib/active-context-store";
import {
  isRecordTerminal,
  reconcileRunState,
  runStateFromLog,
  runStateFromRecord,
  useResumeWorkflow,
  useWorkflowCredentials,
  useWorkflowDeployments,
  useWorkflowRecord,
  useWorkflowRunState,
  useWorkflowStepOutputs,
} from "../hooks/use-workflow";
import { useSkillLibrary } from "../hooks/use-skills";

interface WorkflowRunPaneProps {
  // Opaque run identifier (a thin-executor `runId`, CL-2240). Named
  // `deploymentId` for continuity with the right-pane routing plumbing that
  // threads it through unchanged.
  deploymentId: string;
  tenantId?: string | null;
  onClose: () => void;
}

// Selects the run's own custom Panel when its workflow package ships one, and
// falls back to the generic RunConsole otherwise. The kind comes from the loaded
// run record — never from navigation props. Step outputs are read from the run's
// native event log (CL-2669) and handed to the panel as `stepOutputs`.
export function WorkflowRunPane({
  deploymentId,
  tenantId,
  onClose,
}: WorkflowRunPaneProps) {
  // Guard an empty id so no record query fires against a missing runId.
  if (!deploymentId) {
    return (
      <div className="flex h-full items-center justify-center border border-border bg-bg">
        <p className="text-[13px] text-text-3">Loading…</p>
      </div>
    );
  }

  return (
    <WorkflowRunPaneInner
      deploymentId={deploymentId}
      tenantId={tenantId}
      onClose={onClose}
    />
  );
}

// Separated so hooks below run only once the runId is known non-empty.
function WorkflowRunPaneInner({
  deploymentId,
  tenantId,
  onClose,
}: WorkflowRunPaneProps) {
  const runId = deploymentId;
  const {
    data: record,
    isLoading,
    isError,
  } = useWorkflowRecord(runId, tenantId);
  const { data: logState, isError: logError } = useWorkflowRunState(
    runId,
    tenantId,
  );
  // Step outputs come from the run-keyed log fold (CL-2704) — never the
  // record's deploymentId, which 404s under per-run deployments (CL-2582).
  const { data: stepOutputsData } = useWorkflowStepOutputs(runId, tenantId);
  const resume = useResumeWorkflow(runId, tenantId);
  const { data: credentials } = useWorkflowCredentials(tenantId);
  const { data: skills } = useSkillLibrary(tenantId);
  const { data: deployments } = useWorkflowDeployments(tenantId);
  const signalInFlightRef = useRef(false);
  const [signalPending, setSignalPending] = useState(false);
  // True while a resume is auto-retrying through the deploy window (CL-2707), so
  // the pane shows an honest transient banner instead of flashing an error.
  const [redeploying, setRedeploying] = useState(false);

  const kind = record?.kind ?? null;
  const recordDeploymentId = record?.deploymentId ?? null;

  // Resolve the exact deployment that produced this run so the badge shows the
  // version that actually ran — not the newest deployment of the kind, which
  // would be wrong after a redeploy. Falls back to no badge when the run predates
  // deploymentId persistence or its deployment has since been superseded.
  const deploymentMeta = useMemo(() => {
    if (!deployments || !recordDeploymentId) return null;
    const match = deployments.find(
      (d) => d.deploymentId === recordDeploymentId,
    );
    return match?.meta ?? null;
  }, [deployments, recordDeploymentId]);

  const { data: uiModule } = useQuery({
    queryKey: ["workflow-ui-module", kind],
    queryFn: () => loadWorkflowUI(kind as string),
    enabled: kind !== null,
    staleTime: 5 * 60_000,
  });

  // The stepper's per-step source of truth is the log-derived run state
  // (CL-2669), reconciled with the run-level index status: an aborted or
  // restart-interrupted run is `failed` in the index but non-terminal in the log,
  // so the overlay renders it failed while the log still drives per-step phase.
  // When the log is unavailable (legacy run with no deploymentId, or a read
  // error), fall back to the record-derived run-level state so the pane renders a
  // terminal/failed state instead of hanging on "Loading run…". The panels read
  // step *content* from the log-served step outputs (`stepOutputs`) below.
  const state = useMemo(() => {
    if (!record) return null;
    if (logState) return reconcileRunState(record, runStateFromLog(logState));
    if (logError || record.deploymentId === undefined)
      return runStateFromRecord(record);
    return null;
  }, [record, logState, logError]);

  // The stepId -> resolved output map the panels decode, read from the log.
  const stepOutputs = useMemo(() => stepOutputsData ?? {}, [stepOutputsData]);

  // The run's active step is the log's first in-flight / awaiting step.
  const activeStepId = useMemo(() => {
    const active = logState?.steps.find(
      (s) =>
        s.phase === "in-flight" ||
        s.phase === "awaiting-signal" ||
        s.phase === "awaiting-timer",
    );
    return active?.stepId ?? null;
  }, [logState]);

  const workflowSteps = useMemo(
    () =>
      Object.entries(stepOutputs).map(([name, output]) => ({
        name,
        status: name === activeStepId ? "current" : "done",
        output: typeof output === "string" ? output : JSON.stringify(output),
      })),
    [stepOutputs, activeStepId],
  );

  usePublishActiveContext(
    record
      ? {
          kind: "workflow-run",
          id: runId,
          label: toHumanLabel(record.kind),
          runKind: record.kind,
          status: record.status,
          steps: workflowSteps,
        }
      : null,
    record
      ? `${record.status}:${activeStepId ?? ""}:${workflowSteps.length}`
      : undefined,
  );

  const Panel = uiModule?.Panel;

  // Hoisted above the Panel/RunConsole branch point — it depends only on
  // deploymentMeta, so both render paths can share one element.
  const metaBadge = deploymentMeta ? (
    <WorkflowMetaBadge
      version={deploymentMeta.version}
      sha={deploymentMeta.sha}
      deployedAt={deploymentMeta.deployedAt}
    />
  ) : null;

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center border border-border bg-bg">
        <p className="text-[13px] text-text-3">
          We couldn't load this workflow run. Close and reopen it to retry.
        </p>
      </div>
    );
  }

  if (isLoading || !record || !state) {
    return (
      <div className="flex h-full items-center justify-center border border-border bg-bg">
        <p className="text-[13px] text-text-3">Loading run…</p>
      </div>
    );
  }

  if (!Panel) {
    return (
      <div className="relative h-full">
        <RunConsole
          deploymentId={runId}
          tenantId={tenantId}
          onClose={onClose}
        />
        {metaBadge}
      </div>
    );
  }

  const terminal = isRecordTerminal(record.status);

  // onSignal maps directly to the resume endpoint; no-op once terminal or already posting.
  const handleSignal = (signalName: string, payload?: unknown) => {
    if (terminal || signalInFlightRef.current) return;
    signalInFlightRef.current = true;
    setSignalPending(true);
    setRedeploying(false);
    resume
      .mutateAsync({
        signalName,
        payload,
        onRedeploying: () => setRedeploying(true),
      })
      .catch(() => undefined)
      .finally(() => {
        signalInFlightRef.current = false;
        setSignalPending(false);
        setRedeploying(false);
      });
  };

  return (
    <ErrorBoundary
      fallback={
        <div className="flex h-full items-center justify-center border border-border bg-bg">
          <p className="text-[13px] text-text-3">
            This workflow view ran into a problem rendering. The run is still
            active — close and reopen it to retry.
          </p>
        </div>
      }
    >
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center border border-border bg-bg">
            <p className="text-[13px] text-text-3">Loading workflow…</p>
          </div>
        }
      >
        <div className="relative h-full">
          {redeploying && (
            <div className="absolute inset-x-0 top-0 z-20 border-b border-border bg-surface px-3 py-2 text-center text-[13px] text-text-2">
              Finishing an update — retrying…
            </div>
          )}
          <Panel
            deploymentId={runId}
            state={state}
            connected={
              record.status === "running" || record.status === "awaiting"
            }
            stepOutputs={stepOutputs}
            signalPending={signalPending}
            onSignal={handleSignal}
            onClose={onClose}
            credentials={credentials}
            skills={skills}
          />
          {metaBadge}
        </div>
      </Suspense>
    </ErrorBoundary>
  );
}

// Locale/timezone-independent absolute timestamp: an unambiguous UTC string the
// deploy clock (deployedAt is an ISO string) maps onto identically for everyone.
function formatDeployedAt(deployedAt: string): string {
  const date = new Date(deployedAt);
  if (Number.isNaN(date.getTime())) return deployedAt;
  const iso = date.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return `${day} ${time} UTC`;
}

type Anchor = { bottom: number; right: number };

function WorkflowMetaBadge({
  version,
  sha,
  deployedAt,
}: {
  version: string;
  sha: string;
  deployedAt: string;
}) {
  const label = `v${version} · ${sha}`;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const openPanel = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    setAnchor({
      bottom: rect ? window.innerHeight - rect.top + 8 : 12,
      right: rect ? window.innerWidth - rect.right : 12,
    });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="absolute bottom-3 right-3 z-10">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Workflow version: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : openPanel())}
        className="relative flex h-5 w-5 items-center justify-center rounded-full bg-bg-2 text-text-3 transition-colors hover:bg-bg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange after:absolute after:left-1/2 after:top-1/2 after:h-10 after:w-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
      >
        <Info size={12} aria-hidden />
      </button>

      {open &&
        anchor &&
        createPortal(
          <>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              className="fixed inset-0 z-[60] cursor-default"
              onClick={close}
            />
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="Workflow version details"
              tabIndex={-1}
              onKeyDown={(e) => {
                // Read-only content: trap Tab/Shift+Tab on the panel container so
                // focus can't escape into the Panel/RunConsole behind the overlay.
                if (e.key === "Tab") {
                  e.preventDefault();
                  panelRef.current?.focus();
                }
              }}
              style={{ bottom: anchor.bottom, right: anchor.right }}
              className="fixed z-[61] w-[220px] rounded-[10px] border border-border bg-surface p-3 text-xs shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-orange"
            >
              <dl className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-text-3">Version</dt>
                  <dd className="font-medium text-text">{version}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-text-3">SHA</dt>
                  <dd className="font-mono text-text">{sha}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-text-3">Deployed</dt>
                  <dd className="text-text">{formatDeployedAt(deployedAt)}</dd>
                </div>
              </dl>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
