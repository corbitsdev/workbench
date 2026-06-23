import { Suspense, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RunConsole } from './RunConsole';
import { ErrorBoundary } from './ErrorBoundary';
import { loadWorkflowUI } from '../lib/workflow-ui';
import {
  isRecordTerminal,
  runStateFromRecord,
  useResumeWorkflow,
  useWorkflowCredentials,
  useWorkflowRecord,
} from '../hooks/use-workflow';
import { useSkillLibrary } from '../hooks/use-skills';

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
// run record — never from navigation props. The record's `outputs` map is the
// stepId -> output envelope the panels decode, handed through as `stepOutputs`.
export function WorkflowRunPane({ deploymentId, tenantId, onClose }: WorkflowRunPaneProps) {
  // Guard an empty id so no record query fires against a missing runId.
  if (!deploymentId) {
    return (
      <div className="flex h-full items-center justify-center rounded-panel border border-border bg-bg">
        <p className="text-[13px] text-text-3">Loading…</p>
      </div>
    );
  }

  return <WorkflowRunPaneInner deploymentId={deploymentId} tenantId={tenantId} onClose={onClose} />;
}

// Separated so hooks below run only once the runId is known non-empty.
function WorkflowRunPaneInner({ deploymentId, tenantId, onClose }: WorkflowRunPaneProps) {
  const runId = deploymentId;
  const { data: record, isLoading, isError } = useWorkflowRecord(runId, tenantId);
  const resume = useResumeWorkflow(runId, tenantId);
  const { data: credentials } = useWorkflowCredentials(tenantId);
  const { data: skills } = useSkillLibrary(tenantId);
  const signalInFlightRef = useRef(false);
  const [signalPending, setSignalPending] = useState(false);

  const kind = record?.kind ?? null;

  const { data: uiModule } = useQuery({
    queryKey: ['workflow-ui-module', kind],
    queryFn: () => loadWorkflowUI(kind as string),
    enabled: kind !== null,
    staleTime: 5 * 60_000,
  });

  // The panels read the @intx/workflow RunState shape; synthesize it from the
  // record so their per-step display logic keeps working untouched.
  const state = useMemo(() => (record ? runStateFromRecord(record) : null), [record]);

  const Panel = uiModule?.Panel;

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center rounded-panel border border-border bg-bg">
        <p className="text-[13px] text-text-3">
          We couldn't load this workflow run. Close and reopen it to retry.
        </p>
      </div>
    );
  }

  if (isLoading || !record || !state) {
    return (
      <div className="flex h-full items-center justify-center rounded-panel border border-border bg-bg">
        <p className="text-[13px] text-text-3">Loading run…</p>
      </div>
    );
  }

  if (!Panel) {
    return <RunConsole deploymentId={runId} tenantId={tenantId} onClose={onClose} />;
  }

  const terminal = isRecordTerminal(record.status);

  // The record's outputs map IS the stepId -> output envelope the panels decode.
  const stepOutputs = record.outputs;

  // onSignal maps directly to the resume endpoint; no-op once terminal or already posting.
  const handleSignal = (signalName: string, payload?: unknown) => {
    if (terminal || signalInFlightRef.current) return;
    signalInFlightRef.current = true;
    setSignalPending(true);
    resume
      .mutateAsync({ signalName, payload })
      .catch(() => undefined)
      .finally(() => {
        signalInFlightRef.current = false;
        setSignalPending(false);
      });
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
          deploymentId={runId}
          state={state}
          connected={record.status === 'running' || record.status === 'awaiting'}
          stepOutputs={stepOutputs}
          signalPending={signalPending}
          onSignal={handleSignal}
          onClose={onClose}
          credentials={credentials}
          skills={skills}
        />
      </Suspense>
    </ErrorBoundary>
  );
}
