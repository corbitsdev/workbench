import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type } from 'arktype';
import { resumeFromLog, type RunState, type WorkflowEvent } from '@intx/workflow';
import { api } from '../lib/api';
import { subscribeSharedEventStream } from '../lib/shared-event-stream';

// Same-origin EventSource resolver. A credentialed cross-origin EventSource is
// blocked by Safari (ITP) and Brave (shields); in dev we route the stream
// through the same-origin Vite proxy so the port-agnostic auth cookie still
// authenticates. In prod there is no proxy, so fall back to apiBase like fetch.
const apiBase: string = import.meta.env.VITE_API_BASE_URL ?? '';
function streamUrl(path: string, tenantId?: string | null): string {
  const base = import.meta.env.DEV ? window.location.origin : apiBase || window.location.origin;
  const url = new URL(`/api/v1/${path.replace(/^\//, '')}`, base);
  if (tenantId) url.searchParams.set('tenantId', tenantId);
  return url.toString();
}

// Appends the active workbench tenantId so the hub resolves visibility against
// that workbench (walking ancestors to the global tenant). Omitted when no
// workbench is active, leaving the request scoped to the global tenant.
function withTenant(path: string, tenantId?: string | null): string {
  if (!tenantId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}tenantId=${encodeURIComponent(tenantId)}`;
}

const workflowRunSchema = type({
  deploymentId: 'string',
  kind: 'string',
  status: 'string',
  createdAt: 'string',
});
export type WorkflowRun = typeof workflowRunSchema.infer;
const workflowRunListSchema = workflowRunSchema.array();

export function useWorkflowRuns(tenantId?: string | null) {
  return useQuery<WorkflowRun[]>({
    queryKey: ['workflow-runs', tenantId ?? null],
    queryFn: async () => {
      const raw = await api<unknown>('GET', withTenant('/workflow-runs', tenantId));
      const parsed = workflowRunListSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected workflow-runs response: ${parsed.summary}`);
      }
      return parsed;
    },
  });
}

export interface WorkflowRunStateResult {
  state: RunState | null;
  events: WorkflowEvent[];
  connected: boolean;
}

// The hub streams each run event as `{ seq, runId, event }` where `event` is the
// ON-DISK blob: the state-machine discriminant `kind` is serialized under the
// field name `type` (see @intx/workflow-host repo-store adapter). Parse the SSE
// frame at this trust boundary and convert the on-disk shape back to the
// in-memory WorkflowEvent (`type` -> `kind`) the state machine consumes.
const runStreamFrameSchema = type({
  seq: 'number',
  runId: 'string',
  event: type({ type: 'string', seq: 'number', '+': 'ignore' }),
});

function frameToWorkflowEvent(frame: typeof runStreamFrameSchema.infer): WorkflowEvent {
  const { type: kind, ...rest } = frame.event;
  return { ...rest, kind } as unknown as WorkflowEvent;
}

interface RunFrame {
  runId: string;
  seq: number;
  event: WorkflowEvent;
}

// Subscribe to a deployment's append-only event log over SSE and reduce it into
// the native RunState via resumeFromLog. This is a live stream, not
// request/response data — TanStack Query is for the run list; the stream is
// owned by the shared EventSource registry, mirroring instance-transport.
//
// A deployment's stream carries EVERY run it has produced — each Start is a new
// independent run with its OWN per-run seq sequence (1..N). We therefore key
// frames by `${runId}/${seq}` (so a stream reconnect, which re-tails from seq 0,
// dedupes instead of double-applying), group by runId, and reduce only the most
// recently started run. Concatenating multiple runs' logs into one reduce is an
// invalid event sequence and throws inside the state machine.
export function useWorkflowRunState(
  deploymentId: string | null,
  tenantId?: string | null
): WorkflowRunStateResult {
  const [frames, setFrames] = useState<Map<string, RunFrame>>(new Map());
  const [connected, setConnected] = useState(false);

  // Frames accumulate in a ref and flush to state on a TRAILING debounce. On
  // open the stream replays the whole log from seq 0 in a tight burst; flushing
  // per event would re-render through every intermediate step ("walking" the UI
  // through past steps). Trailing debounce collapses the replay burst into ONE
  // render at the final state — so the panel jumps straight to the active step —
  // while sparse live events (a step completing, then a wait) each flush after
  // the quiet window.
  const framesRef = useRef<Map<string, RunFrame>>(new Map());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!deploymentId) return;
    framesRef.current = new Map();
    setFrames(new Map());
    setConnected(true);
    const url = streamUrl(`/workflow-runs/${deploymentId}/stream`, tenantId);
    const flush = () => {
      flushTimer.current = null;
      setFrames(new Map(framesRef.current));
    };
    const unsubscribe = subscribeSharedEventStream(url, 'message', (raw) => {
      const parsed = runStreamFrameSchema(raw);
      if (parsed instanceof type.errors) return;
      const key = `${parsed.runId}/${String(parsed.seq)}`;
      if (framesRef.current.has(key)) return;
      framesRef.current.set(key, {
        runId: parsed.runId,
        seq: parsed.seq,
        event: frameToWorkflowEvent(parsed),
      });
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(flush, 250);
    });
    return () => {
      setConnected(false);
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      unsubscribe();
    };
  }, [deploymentId, tenantId]);

  // The latest run's events, sorted by its per-run seq. Map insertion order is
  // the stream's chronological delivery order, so the last distinct runId seen
  // is the most recently started run.
  const latestRunEvents = useMemo<WorkflowEvent[]>(() => {
    if (frames.size === 0) return [];
    const byRun = new Map<string, RunFrame[]>();
    for (const frame of frames.values()) {
      const bucket = byRun.get(frame.runId);
      if (bucket === undefined) byRun.set(frame.runId, [frame]);
      else bucket.push(frame);
    }
    const runIds = [...byRun.keys()];
    const latestRunId = runIds[runIds.length - 1];
    if (latestRunId === undefined) return [];
    return (byRun.get(latestRunId) ?? [])
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((frame) => frame.event);
  }, [frames]);

  const state = useMemo<RunState | null>(() => {
    if (latestRunEvents.length === 0) return null;
    const first = latestRunEvents[0];
    const runId = first?.kind === 'RunStarted' ? first.runId : (deploymentId ?? '');
    try {
      return resumeFromLog(runId, latestRunEvents);
    } catch {
      // A partially-delivered log (e.g. a step event observed before its
      // RunStarted) is a transient ordering artifact, not a render error. Show
      // the loading state until the gap fills rather than tripping the boundary.
      return null;
    }
  }, [deploymentId, latestRunEvents]);

  return { state, events: latestRunEvents, connected };
}

const stepOutputSchema = type({ stepId: 'string', output: 'unknown' });

// Fetch and parse a single completed step's resolved output. Single source of
// truth for the step-output endpoint contract — shared by the per-step hook and
// the batched resolver in WorkflowRunPane so the schema is defined once.
export async function fetchStepOutput(
  deploymentId: string,
  stepId: string,
  tenantId?: string | null
): Promise<unknown> {
  const raw = await api<unknown>(
    'GET',
    withTenant(`/workflow-runs/${deploymentId}/steps/${stepId}/output`, tenantId)
  );
  const parsed = stepOutputSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected step-output response: ${parsed.summary}`);
  }
  return parsed.output;
}

// Read a completed workflow step's resolved output content. The native
// substrate stores step output by reference (`inline:` / `blob:`); this hits
// the hub endpoint that replays the run's event log to find the step's
// StepCompleted ref and resolves it to the value.
//
// Gating: the CALLER decides when a step is done. Only enable this for a step
// that has completed and carries an output ref — the endpoint 404s otherwise.
// Output is immutable once a step completes, so it is cached indefinitely.
export function useStepOutput(
  deploymentId: string | null,
  stepId: string | null,
  opts?: { enabled?: boolean; tenantId?: string | null }
) {
  return useQuery<unknown>({
    queryKey: ['workflow-step-output', deploymentId, stepId, opts?.tenantId ?? null],
    enabled: !!deploymentId && !!stepId && (opts?.enabled ?? true),
    staleTime: Infinity,
    queryFn: () => fetchStepOutput(deploymentId as string, stepId as string, opts?.tenantId),
  });
}

export function useStartWorkflow(tenantId?: string | null) {
  return useMutation({
    mutationFn: async ({ kind, input }: { kind: string; input: unknown }) => {
      const res = await api<{ deploymentId: string }>(
        'POST',
        withTenant(`/workflow-runs/${encodeURIComponent(kind)}/start`, tenantId),
        { input }
      );
      return res;
    },
  });
}

// Delete (undeploy) a workflow deployment: operator-gated soft-delete that
// drops it from the list/stream/start, undeploys the sidecar supervisor, and
// stops its step instances. Used to finish/remove a completed or stuck run.
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

export function useSignalWorkflow(deploymentId: string, tenantId?: string | null) {
  return useMutation({
    mutationFn: async ({
      runId,
      signalName,
      payload,
    }: {
      runId: string;
      signalName: string;
      payload?: unknown;
    }) => {
      return api<unknown>('POST', withTenant(`/workflow-runs/${deploymentId}/signal`, tenantId), {
        runId,
        signalName,
        payload,
      });
    },
  });
}
