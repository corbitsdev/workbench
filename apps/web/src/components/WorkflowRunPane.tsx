import {
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import type { UIResponse } from "@workbench/blocks";
import {
  Button,
  formatAbsoluteUtc,
  runStartLabel,
  toHumanLabel,
} from "@workbench/ui";
import { useSetPageChrome } from "../lib/page-chrome";
import { WorkflowRunBlocks } from "./WorkflowRunBlocks";
import { WorkflowStartingIndicator } from "./WorkflowStartingIndicator";
import { ErrorBoundary } from "./ErrorBoundary";
import { loadWorkflowUI } from "../lib/workflow-ui";
import { resolveResumePayload } from "../lib/resume-payload";
import { usePublishActiveContext } from "../lib/active-context-store";
import { useWorkflowsCatalog } from "../hooks/use-workflows-catalog";
import {
  isRecordTerminal,
  reconcileRunState,
  runStateFromLog,
  runStateFromRecord,
  runWasInterrupted,
  useResumeWorkflow,
  useStopWorkflowRun,
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
  /**
   * Hosted inside the unified Workflows list inspector. Skips page chrome and
   * per-kind Panel modules so the surface matches dock blocks + GateBlock/StepList
   * substrate instead of a full stage-set takeover.
   */
  embedded?: boolean;
}

// Selects the run's own custom Panel when its workflow package ships one, and
// falls back to the generic UIBlocks view (WorkflowRunBlocks) otherwise — the
// same block substrate the chat dock renders. The kind comes from the loaded
// run record — never from navigation props. Step outputs are read from the run's
// native event log (CL-2669) and handed to the panel as `stepOutputs`.
export function WorkflowRunPane({
  deploymentId,
  tenantId,
  onClose,
  embedded = false,
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
      embedded={embedded}
    />
  );
}

// Separated so hooks below run only once the runId is known non-empty.
function WorkflowRunPaneInner({
  deploymentId,
  tenantId,
  onClose,
  embedded = false,
}: WorkflowRunPaneProps) {
  const runId = deploymentId;
  const reduceMotion = useReducedMotion();
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
  const stopRun = useStopWorkflowRun(tenantId);
  const { data: credentials } = useWorkflowCredentials(tenantId);
  const { data: skills } = useSkillLibrary(tenantId);
  const { data: deployments } = useWorkflowDeployments(tenantId);
  // Warm from the Workflows page in the common case (5-minute staleTime) — the
  // run pane's full step sequence comes from here, not the run's own log, so it
  // is populated even before the run has materialized its first step (CL-4285).
  const { data: catalog } = useWorkflowsCatalog(tenantId);
  const signalInFlightRef = useRef(false);
  // The specific gate we submitted: stepId + signalName at click. Clears when
  // THAT step is no longer awaiting that signal (or the run goes terminal) —
  // not when /resume returns. Signal-only latching wrongly sticks when two
  // concurrent gates share a signal name; step identity fixes that.
  const pendingGateRef = useRef<{
    stepId: string;
    signalName: string;
  } | null>(null);
  const [signalPending, setSignalPending] = useState(false);
  // True while a resume is auto-retrying through the deploy window (CL-2707), so
  // the pane shows an honest transient banner instead of flashing an error.
  const [redeploying, setRedeploying] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);

  const kind = record?.kind ?? null;
  const recordDeploymentId = record?.deploymentId ?? null;

  // The full ordered step sequence for this run's kind — the same classified
  // list the Workflows catalog card renders (CL-4285). Undefined while the
  // catalog hasn't loaded yet or the kind isn't found in it (e.g. a run whose
  // kind was since disabled).
  const catalogSteps = useMemo(
    () => catalog?.entries.find((e) => e.kind === kind)?.steps,
    [catalog, kind],
  );

  // Resolve the exact deployment that produced this run so the badge shows the
  // version that actually ran — not the newest deployment of the kind, which
  // would be wrong after a redeploy. The record's own meta is authoritative and
  // ownership-checked; it survives an owner disabling the kind (which drops the
  // deployment from the grant-filtered catalog list). Fall back to the catalog
  // list only for runs whose record predates version-meta persistence, and to no
  // badge when neither carries it.
  const deploymentMeta = useMemo(() => {
    if (record?.meta) return record.meta;
    if (!deployments || !recordDeploymentId) return null;
    const match = deployments.find(
      (d) => d.deploymentId === recordDeploymentId,
    );
    return match?.meta ?? null;
  }, [record?.meta, deployments, recordDeploymentId]);

  const { data: uiModule, isPending: uiModulePending } = useQuery({
    queryKey: ["workflow-ui-module", kind],
    queryFn: () => loadWorkflowUI(kind as string),
    enabled: kind !== null && !embedded,
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

  // The set of awaitSignal names the run is currently parked on. Derived with the
  // same predicate as the shared gate router (phase `awaiting-signal` +
  // recovered `awaitingSignalName`): a run can hold several concurrently.
  const awaitingSignalNames = useMemo(() => {
    const names = new Set<string>();
    for (const s of logState?.steps ?? []) {
      if (s.phase === "awaiting-signal" && s.awaitingSignalName !== undefined)
        names.add(s.awaitingSignalName);
    }
    return names;
  }, [logState]);

  // Release the pending latch only on a POSITIVE advance: the specific signal we
  // submitted is no longer in the run's awaiting-signal set (its gate was
  // consumed), or the run went terminal. We never clear on a transient poll gap —
  // if the log hasn't loaded (`logState` undefined) we hold the latch, so a
  // momentary null read can't re-enable the button. A stalled backend (resume 200
  // but the run never moves) keeps the button disabled and "Working…" showing —
  // honest, since the run is still parked on our gate.
  useEffect(() => {
    if (!signalPending) return;
    const terminalNow = record ? isRecordTerminal(record.status) : false;
    if (terminalNow) {
      pendingGateRef.current = null;
      signalInFlightRef.current = false;
      setSignalPending(false);
      return;
    }
    if (!logState) return;
    const submitted = pendingGateRef.current;
    if (submitted === null) return;
    const step = logState.steps.find((s) => s.stepId === submitted.stepId);
    const gateConsumed =
      submitted.stepId === ""
        ? !awaitingSignalNames.has(submitted.signalName)
        : step === undefined ||
          step.phase !== "awaiting-signal" ||
          step.awaitingSignalName !== submitted.signalName;
    if (gateConsumed) {
      pendingGateRef.current = null;
      signalInFlightRef.current = false;
      setSignalPending(false);
    }
  }, [awaitingSignalNames, logState, signalPending, record]);

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

  const Panel = embedded ? undefined : uiModule?.Panel;

  const terminal = record ? isRecordTerminal(record.status) : false;
  const stopping = stopRun.isPending;
  const runChrome = useMemo(
    () => (
      <div
        className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3"
        onMouseLeave={() => {
          if (!stopping) setConfirmingStop(false);
        }}
      >
        {deploymentMeta ? (
          <WorkflowMetaBadge
            version={deploymentMeta.version}
            sha={deploymentMeta.sha}
            deployedAt={deploymentMeta.deployedAt}
          />
        ) : null}
        {record &&
          !terminal &&
          (confirmingStop ? (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={stopping}
                data-testid="run-pane-stop-confirm"
                onClick={() => {
                  stopRun.mutate(runId);
                }}
                aria-label="Confirm: stop this run"
              >
                {stopping ? "Stopping…" : "Confirm stop"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={stopping}
                onClick={() => setConfirmingStop(false)}
                aria-label="Cancel stop"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={stopping}
              data-testid="run-pane-stop"
              onClick={() => setConfirmingStop(true)}
              title="Stop this run — leaves it in history as Stopped"
              aria-label="Stop this run"
            >
              Stop
            </Button>
          ))}
        {record && !terminal && stopRun.isError && (
          <span role="alert" className="text-xs text-red-500">
            Couldn't stop this run. Try again.
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    ),
    [
      deploymentMeta,
      onClose,
      record,
      terminal,
      confirmingStop,
      stopping,
      stopRun.isError,
      // Depend on mutate only — the full mutation object is a new identity each
      // render and would re-publish chrome every frame (see ArtifactDetailPage).
      stopRun.mutate,
      runId,
    ],
  );
  useSetPageChrome(record ? runChrome : null, !embedded);

  // Index says failed but the log is still non-terminal — the run was killed
  // externally (redeploy/abort), not a genuine step failure. Drives the
  // interrupted-vs-failed copy in the generic blocks fallback.
  const interrupted =
    record !== undefined &&
    logState !== undefined &&
    runWasInterrupted(record, logState.phase);

  // CL-2785: the fast SSE log state (`logState.phase`) flips off `pending` a beat
  // before the slower `record.status` projection reports `running`. Derive
  // `started` from the log first so the coarse "Starting…" gate lifts the moment
  // the run is genuinely live, not ~2s later when the record projection lands.
  const logStarted = logState !== undefined && logState.phase !== "pending";
  const started =
    logStarted || record?.status === "running" || record?.status === "awaiting";

  // onSignal maps directly to the resume endpoint; no-op once terminal or while a
  // signal is still latched (guards double-submit for the FULL latch window, not
  // just the in-flight POST).
  const handleSignal = (signalName: string, payload?: unknown) => {
    if (terminal || signalInFlightRef.current) return;
    signalInFlightRef.current = true;
    // Capture the signal we're submitting; the effect above clears the latch only
    // once THIS signal leaves the awaiting-signal set. The latch — and the
    // in-flight guard — stay set through the POST's resolution, because /resume
    // only delivers the signal, it doesn't advance the run. So the button stays
    // disabled and "Working…" shows until the gate we acted on actually advances,
    // never re-enabling on the same still-parked gate.
    const latchStep =
      logState?.steps.find(
        (s) =>
          s.phase === "awaiting-signal" && s.awaitingSignalName === signalName,
      ) ?? null;
    pendingGateRef.current =
      latchStep !== null
        ? { stepId: latchStep.stepId, signalName }
        : { stepId: "", signalName };
    setSignalPending(true);
    setRedeploying(false);
    resume
      .mutateAsync({
        signalName,
        payload,
        onRedeploying: () => setRedeploying(true),
      })
      .catch(() => {
        // On failure, release the latch and the in-flight guard so the user can
        // retry, and let the resume hook's error surface through the failure path.
        pendingGateRef.current = null;
        signalInFlightRef.current = false;
        setSignalPending(false);
      })
      .finally(() => {
        setRedeploying(false);
      });
  };

  // Resume from a UIBlock response (the generic WorkflowRunBlocks fallback). A
  // gate choice/form carries its `awaitSignal` name; the block awaits the
  // returned mutation promise and shows its own inline pending/error, so the
  // user's input survives a failed resume (CL-2684). A non-gate response (no
  // signalName) is ignored. Mirrors the WorkflowDock card's onRespond so a block
  // resumes identically on both surfaces.
  const onBlockRespond = (response: UIResponse): void | Promise<void> => {
    if (response.signalName === undefined) return;
    if (terminal || resume.isPending) return;
    setRedeploying(false);
    return resume
      .mutateAsync({
        signalName: response.signalName,
        payload: resolveResumePayload(response),
        onRedeploying: () => setRedeploying(true),
      })
      .then(() => undefined)
      .finally(() => setRedeploying(false));
  };

  // Resolve the current pane view as a keyed node so the top-level transition
  // below can crossfade between coarse phases (loading / provisioning /
  // first-frame / panel). Early guards narrow record/state within each branch.
  function renderView(): { key: string; node: ReactNode } {
    if (isError) {
      return {
        key: "error",
        node: (
          <div className="flex h-full items-center justify-center border border-border bg-bg">
            <p className="text-[13px] text-text-3">
              We couldn't load this workflow run. Close and reopen it to retry.
            </p>
          </div>
        ),
      };
    }

    if (isLoading || !record || !state) {
      return {
        key: "loading",
        node: (
          <div className="flex h-full items-center justify-center border border-border bg-bg">
            <p className="text-[13px] text-text-3">Loading workflow…</p>
          </div>
        ),
      };
    }

    // CL-2755: a run still cold-starting its per-run deployment shows a live
    // "Starting…" state WITH motion — never a frozen empty panel — until the
    // projection advances it to `running`. CL-2786: this and the
    // module-loading sub-state below share ONE stable AnimatePresence key
    // ("starting"), so the WorkflowStartingIndicator node stays continuously
    // mounted across provisioning→loading-workflow. Since `mode="wait"` never
    // fires an exit/enter at a same-key boundary, the CSS `animate-spin` never
    // restarts from 0° and there is no blank beat — only the label text swaps.
    if (record.status === "provisioning" && !started) {
      return {
        key: "starting",
        node: (
          <WorkflowStartingIndicator
            variant="pane"
            label={runStartLabel(state)}
          />
        ),
      };
    }

    // CL-2755 (handoff flicker): once the run flips provisioning→running we
    // don't yet know whether this kind ships a custom Panel — the module is
    // still loading. Keep showing the animated loading state so a panel workflow
    // goes Starting → Panel directly, WITHOUT a flash of the generic blocks
    // shell in between. Shares the "starting" key with the provisioning frame so
    // the spinner node persists (no remount) — only the label changes.
    // Embedded inspector always uses shared blocks (dock parity), so skip the
    // module-loading wait entirely.
    if (!embedded && uiModulePending) {
      return {
        key: "starting",
        node: (
          <WorkflowStartingIndicator variant="pane" label="Loading workflow…" />
        ),
      };
    }

    if (!Panel) {
      return {
        key: "console",
        node: (
          <div className="relative h-full">
            {redeploying && (
              <div className="absolute inset-x-0 top-0 z-20 border-b border-border bg-surface px-3 py-2 text-center text-[13px] text-text-2">
                Finishing an update — retrying…
              </div>
            )}
            <WorkflowRunBlocks
              runId={runId}
              kind={record.kind}
              state={state}
              logState={logState}
              stepOutputs={stepOutputs}
              terminal={terminal}
              interrupted={interrupted}
              catalogSteps={catalogSteps}
              onRespond={onBlockRespond}
              onClose={onClose}
            />
          </div>
        ),
      };
    }

    return {
      key: "panel",
      node: (
        <ErrorBoundary
          fallback={
            <div className="flex h-full items-center justify-center border border-border bg-bg">
              <p className="text-[13px] text-text-3">
                This workflow view ran into a problem rendering. The run is
                still active — close and reopen it to retry.
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
              {signalPending && <WorkingIndicator />}
              <Panel
                deploymentId={runId}
                state={state}
                logRead={logState !== undefined}
                connected={!terminal && started}
                stepOutputs={stepOutputs}
                signalPending={signalPending}
                onSignal={handleSignal}
                onClose={onClose}
                hostProvidesChrome
                credentials={credentials}
                skills={skills}
              />
            </div>
          </Suspense>
        </ErrorBoundary>
      ),
    };
  }

  const view = renderView();

  // CL-2781: crossfade between the coarse pane phases so the provisioning /
  // "Loading run…" → first streamed frame no longer hard-cuts a full layout
  // swap. Reduced motion collapses it to an instant show.
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={view.key}
        className="h-full"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
      >
        {view.node}
      </motion.div>
    </AnimatePresence>
  );
}

// One shared, always-animated "Working…" indicator for the whole latch window.
// Rendered by the pane (not each panel) so EVERY unmigrated legacy panel — whose
// own gate button only dims statically, or doesn't change at all — shows live
// motion from click until the gate advances. `animate-spin` guarantees actual
// motion, not a static string, so the pane never reads as frozen.
function WorkingIndicator() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-[13px] text-text-2 shadow-md"
    >
      <span
        aria-hidden
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-text-3 border-t-transparent"
      />
      Working…
    </div>
  );
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
                // focus can't escape into the Panel/blocks view behind the overlay.
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
                  <dd className="text-text">{formatAbsoluteUtc(deployedAt)}</dd>
                </div>
              </dl>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
