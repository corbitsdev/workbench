import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { type } from "arktype";
import {
  resumeFromLog,
  type RunState,
  type WorkflowEvent,
} from "@intx/workflow";
import { api } from "../lib/api";
import { subscribeSharedEventStream } from "../lib/shared-event-stream";

// Same-origin EventSource resolver. A credentialed cross-origin EventSource is
// blocked by Safari (ITP) and Brave (shields); in dev we route the stream
// through the same-origin Vite proxy so the port-agnostic auth cookie still
// authenticates. In prod there is no proxy, so fall back to apiBase like fetch.
const apiBase: string = import.meta.env.VITE_API_BASE_URL ?? "";
function streamUrl(path: string): string {
  const base = import.meta.env.DEV
    ? window.location.origin
    : apiBase || window.location.origin;
  return new URL(`/api/v1/${path.replace(/^\//, "")}`, base).toString();
}

const workflowRunSchema = type({
  deploymentId: "string",
  kind: "string",
  status: "string",
  createdAt: "string",
});
export type WorkflowRun = typeof workflowRunSchema.infer;
const workflowRunListSchema = workflowRunSchema.array();

export function useWorkflowRuns() {
  return useQuery<WorkflowRun[]>({
    queryKey: ["workflow-runs"],
    queryFn: async () => {
      const raw = await api<unknown>("GET", "/workflow-runs");
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

// Subscribe to a run's append-only event log over SSE and reduce it into the
// native RunState via resumeFromLog. This is a live stream, not request/response
// data — TanStack Query is for the run list; the stream is owned by the shared
// EventSource registry, mirroring instance-transport.
export function useWorkflowRunState(
  deploymentId: string | null,
): WorkflowRunStateResult {
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!deploymentId) return;
    setEvents([]);
    setConnected(true);
    const url = streamUrl(`/workflow-runs/${deploymentId}/stream`);
    const unsubscribe = subscribeSharedEventStream(url, "message", (event) => {
      setEvents((prev) => [...prev, event as WorkflowEvent]);
    });
    return () => {
      setConnected(false);
      unsubscribe();
    };
  }, [deploymentId]);

  const state = useMemo<RunState | null>(() => {
    if (!deploymentId || events.length === 0) return null;
    const runId =
      events[0]?.kind === "RunStarted" ? events[0].runId : deploymentId;
    return resumeFromLog(runId, events);
  }, [deploymentId, events]);

  return { state, events, connected };
}

const stepOutputSchema = type({ stepId: "string", output: "unknown" });

// Fetch and parse a single completed step's resolved output. Single source of
// truth for the step-output endpoint contract — shared by the per-step hook and
// the batched resolver in WorkflowRunPane so the schema is defined once.
export async function fetchStepOutput(
  deploymentId: string,
  stepId: string,
): Promise<unknown> {
  const raw = await api<unknown>(
    "GET",
    `/workflow-runs/${deploymentId}/steps/${stepId}/output`,
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
  opts?: { enabled?: boolean },
) {
  return useQuery<unknown>({
    queryKey: ["workflow-step-output", deploymentId, stepId],
    enabled: !!deploymentId && !!stepId && (opts?.enabled ?? true),
    staleTime: Infinity,
    queryFn: () => fetchStepOutput(deploymentId as string, stepId as string),
  });
}

export function useStartWorkflow() {
  return useMutation({
    mutationFn: async ({ kind, input }: { kind: string; input: unknown }) => {
      const res = await api<{ deploymentId: string }>(
        "POST",
        `/workflow-runs/${encodeURIComponent(kind)}/start`,
        { input },
      );
      return res;
    },
  });
}

export function useSignalWorkflow(deploymentId: string) {
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
      return api<unknown>("POST", `/workflow-runs/${deploymentId}/signal`, {
        runId,
        signalName,
        payload,
      });
    },
  });
}
