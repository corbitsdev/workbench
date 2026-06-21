import { Suspense, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RunConsole } from './RunConsole';
import { ErrorBoundary } from './ErrorBoundary';
import { loadWorkflowUI } from '../lib/workflow-ui';
import {
  useWorkflowRuns,
  useWorkflowRunState,
  useSignalWorkflow,
  fetchStepOutput,
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

  const { state, connected } = useWorkflowRunState(deploymentId, tenantId);
  const signal = useSignalWorkflow(deploymentId, tenantId);

  const Panel = uiModule?.Panel;

  // Stable key of completed steps that carry an output, so the outputs query
  // only refetches when a new step finishes.
  const completedStepIds = useMemo(() => {
    if (!state) return [];
    return [...state.steps.values()]
      .filter((s) => s.phase === 'completed' && s.outputRef !== undefined)
      .map((s) => s.stepId)
      .sort();
  }, [state]);

  // Resolve each completed step's output INDEPENDENTLY: one step that fails or
  // returns a malformed payload must degrade only its own panel section, never
  // blank the others. Failed steps are simply omitted from the map (the Panel
  // contract treats a missing key as "no output"), so a sibling step's data
  // still renders.
  const { data: stepOutputs = {} } = useQuery({
    queryKey: ['workflow-step-outputs', deploymentId, tenantId ?? null, completedStepIds],
    queryFn: async () => {
      const settled = await Promise.allSettled(
        completedStepIds.map((stepId) => fetchStepOutput(deploymentId, stepId, tenantId))
      );
      const map: Record<string, unknown> = {};
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          map[completedStepIds[index] as string] = result.value;
        }
      });
      return map;
    },
    enabled: Boolean(Panel) && completedStepIds.length > 0,
    staleTime: Infinity,
  });

  if (!Panel) {
    return <RunConsole deploymentId={deploymentId} tenantId={tenantId} onClose={onClose} />;
  }

  const handleSignal = (signalName: string, payload?: unknown) => {
    if (!state) return;
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
