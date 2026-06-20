import { Suspense, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RunConsole } from './RunConsole';
import { loadWorkflowUI } from '../lib/workflow-ui';
import { useWorkflowRuns, useWorkflowRunState, useSignalWorkflow } from '../hooks/use-workflow';

interface WorkflowRunPaneProps {
  deploymentId: string;
  onClose: () => void;
}

// Selects the run's own custom Panel when its workflow package ships one, and
// falls back to the generic RunConsole otherwise. The kind is derived from the
// loaded run list keyed by deploymentId — never from navigation props.
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
  if (!Panel) {
    return <RunConsole deploymentId={deploymentId} onClose={onClose} />;
  }

  const handleSignal = (signalName: string, payload?: unknown) => {
    if (!state) return;
    signal.mutateAsync({ runId: state.runId, signalName, payload }).catch(() => undefined);
  };

  return (
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
        onSignal={handleSignal}
        onClose={onClose}
      />
    </Suspense>
  );
}
