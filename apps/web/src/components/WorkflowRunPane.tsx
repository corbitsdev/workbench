import { Suspense, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type } from 'arktype';
import { RunConsole } from './RunConsole';
import { ErrorBoundary } from './ErrorBoundary';
import { loadWorkflowUI } from '../lib/workflow-ui';
import { api } from '../lib/api';
import { useWorkflowRuns, useWorkflowRunState, useSignalWorkflow } from '../hooks/use-workflow';

interface WorkflowRunPaneProps {
  deploymentId: string;
  onClose: () => void;
}

const stepOutputResponse = type({ stepId: 'string', output: 'unknown' });

// Selects the run's own custom Panel when its workflow package ships one, and
// falls back to the generic RunConsole otherwise. The kind is derived from the
// loaded run list keyed by deploymentId — never from navigation props. Completed
// steps' outputs are resolved here (host-side) and handed to the Panel as the
// `stepOutputs` map so panels stay pure presentational components.
export function WorkflowRunPane({ deploymentId, onClose }: WorkflowRunPaneProps) {
  const { data: runs = [] } = useWorkflowRuns();
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

  const { state, connected } = useWorkflowRunState(deploymentId);
  const signal = useSignalWorkflow(deploymentId);

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

  const { data: stepOutputs = {} } = useQuery({
    queryKey: ['workflow-step-outputs', deploymentId, completedStepIds],
    queryFn: async () => {
      const entries = await Promise.all(
        completedStepIds.map(async (stepId) => {
          const raw = await api<unknown>(
            'GET',
            `/workflow-runs/${deploymentId}/steps/${stepId}/output`
          );
          const parsed = stepOutputResponse(raw);
          if (parsed instanceof type.errors) {
            throw new Error(`Unexpected step-output response: ${parsed.summary}`);
          }
          return [stepId, parsed.output] as const;
        })
      );
      return Object.fromEntries(entries) as Record<string, unknown>;
    },
    enabled: Boolean(Panel) && completedStepIds.length > 0,
    staleTime: Infinity,
  });

  if (!Panel) {
    return <RunConsole deploymentId={deploymentId} onClose={onClose} />;
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
