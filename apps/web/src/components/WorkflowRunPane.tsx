import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RunConsole } from './RunConsole';
import { ErrorBoundary } from './ErrorBoundary';
import { loadWorkflowUI } from '../lib/workflow-ui';
import {
  useWorkflowRuns,
  useWorkflowRunState,
  useSignalWorkflow,
  useAllStepOutputs,
  useSetWorkflowStatus,
  isTerminalPhase,
} from '../hooks/use-workflow';

interface WorkflowRunPaneProps {
  deploymentId: string;
  tenantId?: string | null;
  onClose: () => void;
}

// Selects the run's own custom Panel when its workflow package ships one, and
// falls back to the generic RunConsole otherwise. The kind is derived from the
// loaded run list keyed by deploymentId — never from navigation props. Completed
// steps' outputs are resolved here (host-side) and handed to the Panel as the
// `stepOutputs` map so panels stay pure presentational components.
export function WorkflowRunPane({ deploymentId, tenantId, onClose }: WorkflowRunPaneProps) {
  // Bug fix (3): guard against an empty deploymentId propagating into hooks and
  // triggering a `/workflow-runs//stream` 404. Render nothing until we have one.
  if (!deploymentId) {
    return (
      <div className="flex h-full items-center justify-center rounded-panel border border-border bg-bg">
        <p className="text-[13px] text-text-3">Loading…</p>
      </div>
    );
  }

  return <WorkflowRunPaneInner deploymentId={deploymentId} tenantId={tenantId} onClose={onClose} />;
}

// Separated so that all hooks below are called only after deploymentId is known
// to be non-empty. React requires consistent hook call order per render, so we
// can't conditionally invoke hooks inside WorkflowRunPane.
function WorkflowRunPaneInner({ deploymentId, tenantId, onClose }: WorkflowRunPaneProps) {
  const { data: runs = [] } = useWorkflowRuns(tenantId);
  const kind = useMemo(
    () => runs.find((run) => run.deploymentId === deploymentId)?.kind ?? null,
    [runs, deploymentId]
  );

  const { data: uiModule } = useQuery({
    queryKey: ['workflow-ui-module', kind],
    queryFn: () => loadWorkflowUI(kind as string),
    enabled: kind !== null,
    staleTime: 5 * 60_000,
  });

  // Bug fix (1): `settled` is false while the initial SSE backlog is being
  // replayed — the debounce hasn't fired yet. Show "Loading run…" until it
  // becomes true so the UI never animates through past steps.
  const { state, connected, settled } = useWorkflowRunState(deploymentId, tenantId);

  const terminal = state !== null && isTerminalPhase(state.phase);

  // Bug fix (5): persist terminal status to the hub once (idempotent via the
  // ref so a re-render doesn't fire a second PATCH).
  const setStatus = useSetWorkflowStatus(tenantId);
  const statusPersisted = useRef<string | null>(null);
  useEffect(() => {
    if (!terminal || !state) return;
    if (statusPersisted.current === state.phase) return;
    statusPersisted.current = state.phase;
    setStatus.mutate({ deploymentId, status: state.phase }, { onError: () => undefined });
  }, [terminal, state, deploymentId, setStatus]);

  // Bug fix (2): gate signal mutations when the run is in a terminal phase.
  const signal = useSignalWorkflow(deploymentId, tenantId);

  const Panel = uiModule?.Panel;

  // Bug fix (4): replace per-step allSettled batch with a single bulk call.
  // Re-keyed on `state.lastSeq` so TanStack Query refetches as new steps
  // complete without re-fetching already-resolved outputs unnecessarily.
  const { data: allOutputs } = useAllStepOutputs(Panel ? deploymentId : null, tenantId, {
    lastSeq: state?.lastSeq,
  });

  // Only expose outputs for completed steps that carry an outputRef; any key
  // missing from the bulk response is simply absent from the map.
  const stepOutputs = useMemo<Record<string, unknown>>(() => {
    if (!state || !allOutputs) return {};
    const map: Record<string, unknown> = {};
    for (const [stepId, s] of state.steps) {
      if (s.phase === 'completed' && s.outputRef !== undefined && stepId in allOutputs) {
        map[stepId] = allOutputs[stepId];
      }
    }
    return map;
  }, [state, allOutputs]);

  if (!Panel) {
    return <RunConsole deploymentId={deploymentId} tenantId={tenantId} onClose={onClose} />;
  }

  // Bug fix (1): show a stable loading placeholder until the backlog settles.
  if (!settled) {
    return (
      <div className="flex h-full items-center justify-center rounded-panel border border-border bg-bg">
        <p className="text-[13px] text-text-3">Loading run…</p>
      </div>
    );
  }

  // Bug fix (2): onSignal is a no-op when the run has reached a terminal phase.
  const handleSignal = (signalName: string, payload?: unknown) => {
    if (!state || terminal) return;
    signal.mutateAsync({ runId: state.runId, signalName, payload }).catch(() => undefined);
  };

  return (
    <ErrorBoundary
      fallback={
        <div className="flex h-full items-center justify-center rounded-panel border border-border bg-bg">
          <p className="text-[13px] text-text-3">
            This workflow view ran into a problem rendering. The run is still active — close and
            reopen it to retry.
          </p>
        </div>
      }
    >
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center rounded-panel border border-border bg-bg">
            <p className="text-[13px] text-text-3">Loading workflow…</p>
          </div>
        }
      >
        <Panel
          deploymentId={deploymentId}
          state={state}
          connected={connected}
          stepOutputs={stepOutputs}
          onSignal={handleSignal}
          onClose={onClose}
        />
      </Suspense>
    </ErrorBoundary>
  );
}
