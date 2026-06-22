import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type } from 'arktype';
import { api } from '../lib/api';
import { isRecordTerminal, runStateFromRecord, type RunRecord } from '../lib/run-state-adapter';

// Appends the active workbench tenantId so the hub resolves visibility against
// that workbench (walking ancestors to the global tenant). Omitted when no
// workbench is active, leaving the request scoped to the global tenant.
function withTenant(path: string, tenantId?: string | null): string {
  if (!tenantId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}tenantId=${encodeURIComponent(tenantId)}`;
}

// Thin-executor run record (CL-2240). State lives in a single row read from the
// hub; there is no SSE event log to reduce. Parse every response at the boundary.
const runRecordSchema = type({
  runId: 'string',
  kind: 'string',
  status: "'running'|'awaiting'|'completed'|'failed'",
  currentStepId: 'string|null',
  outputs: type({ '[string]': 'unknown' }),
  'error?': 'string',
});

function parseRunRecord(raw: unknown): RunRecord {
  const parsed = runRecordSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected workflow run-record response: ${parsed.summary}`);
  }
  return parsed;
}

const workflowRunSchema = type({
  runId: 'string',
  kind: 'string',
  status: 'string',
  createdAt: 'string',
});
export type WorkflowRun = typeof workflowRunSchema.infer;
const workflowRunListSchema = workflowRunSchema.array();

const workflowDeploymentSchema = type({
  deploymentId: 'string',
  kind: 'string',
  status: 'string',
  createdAt: 'string',
});
export type WorkflowDeployment = typeof workflowDeploymentSchema.infer;
const workflowDeploymentListSchema = workflowDeploymentSchema.array();

export function useWorkflowRuns(tenantId?: string | null) {
  return useQuery<WorkflowRun[]>({
    queryKey: ['workflow-runs', tenantId ?? null],
    refetchInterval: 5000,
    queryFn: async () => {
      const raw = await api<unknown>('GET', withTenant('/workflow-exec/records', tenantId));
      const parsed = workflowRunListSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected workflow-records response: ${parsed.summary}`);
      }
      return parsed;
    },
  });
}

export function useWorkflowDeployments(tenantId?: string | null) {
  return useQuery<WorkflowDeployment[]>({
    queryKey: ['workflow-deployments', tenantId ?? null],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const raw = await api<unknown>('GET', withTenant('/workflow-runs', tenantId));
      const parsed = workflowDeploymentListSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected workflow-runs response: ${parsed.summary}`);
      }
      return parsed;
    },
  });
}

export { isRecordTerminal };

// Read a thin-executor run record and poll while it is advancing. The hub runs
// each non-gate step synchronously, so the record only changes between reads
// while `status === 'running'` (a step is executing): we poll then, and stop
// the moment the run goes quiescent — parked on a gate (`awaiting`) or terminal
// (`completed`/`failed`) — mirroring the old auto-stop-at-quiescent behavior.
// staleTime 0 so a resume's fresh state is never served stale.
export function useWorkflowRecord(runId: string | null, tenantId?: string | null) {
  return useQuery<RunRecord>({
    queryKey: ['workflow-record', runId, tenantId ?? null],
    enabled: !!runId,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 500 : false),
    queryFn: async () => {
      const raw = await api<unknown>(
        'GET',
        withTenant(`/workflow-exec/records/${runId as string}`, tenantId)
      );
      return parseRunRecord(raw);
    },
  });
}

export function useStartWorkflow(tenantId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, input }: { kind: string; input: unknown }) => {
      const raw = await api<unknown>(
        'POST',
        withTenant(`/workflow-exec/${encodeURIComponent(kind)}/start`, tenantId),
        { input }
      );
      return parseRunRecord(raw);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflow-runs'] });
    },
  });
}

// Resume a gated run: posts the gate signal and writes the returned fresh record
// straight into the record query cache so the panel advances without waiting for
// the next poll. The active gate is parked, so polling is off until this fires.
export function useResumeWorkflow(runId: string, tenantId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ signalName, payload }: { signalName: string; payload?: unknown }) => {
      const raw = await api<unknown>(
        'POST',
        withTenant(`/workflow-exec/records/${encodeURIComponent(runId)}/resume`, tenantId),
        { signalName, payload }
      );
      return parseRunRecord(raw);
    },
    onSuccess: (record) => {
      queryClient.setQueryData(['workflow-record', runId, tenantId ?? null], record);
    },
  });
}

// Delete (undeploy) a workflow deployment: operator-gated soft-delete that
// drops it from the list/start. Used to finish/remove a completed or stuck run.
export function useDeleteWorkflow(tenantId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (deploymentId: string) =>
      api<unknown>(
        'DELETE',
        withTenant(`/workflows/${encodeURIComponent(deploymentId)}`, tenantId)
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflow-runs'] });
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
}

export { runStateFromRecord };
