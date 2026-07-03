import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import { api } from "../lib/api";
import {
  isLogStateTerminal,
  isRecordTerminal,
  logRunStateSchema,
  reconcileRunState,
  runStateFromLog,
  runStateFromRecord,
  runWasInterrupted,
  stepOutputsFromLog,
  type LogRunState,
  type RunRecord,
} from "../lib/run-state-adapter";

// Appends the active workbench tenantId so the hub resolves visibility against
// that workbench (walking ancestors to the global tenant). Omitted when no
// workbench is active, leaving the request scoped to the global tenant.
function withTenant(path: string, tenantId?: string | null): string {
  if (!tenantId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}tenantId=${encodeURIComponent(tenantId)}`;
}

// Thin-executor run record (CL-2240). State lives in a single row read from the
// hub; there is no SSE event log to reduce. Parse every response at the boundary.
const runRecordSchema = type({
  runId: "string",
  kind: "string",
  status: "'running'|'awaiting'|'completed'|'failed'",
  "deploymentId?": "string",
});

function parseRunRecord(raw: unknown): RunRecord {
  const parsed = runRecordSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Unexpected workflow run-record response: ${parsed.summary}`,
    );
  }
  return parsed;
}

const workflowRunSchema = type({
  runId: "string",
  kind: "string",
  status: "string",
  createdAt: "string",
});
export type WorkflowRun = typeof workflowRunSchema.infer;
const workflowRunListSchema = workflowRunSchema.array();

// Mirror of apps/hub/src/lib/workflow-meta.ts (separate build graphs make a
// literal import non-trivial). `deployedAt` is an ISO string at the source.
const workflowMetaSchema = type({
  version: "string",
  sha: "string",
  deployedAt: "string.date.iso",
  // The workflow's display name + one-line description, captured at deploy time
  // (optional — older deployments carry none).
  "label?": "string",
  "description?": "string",
});
export type WorkflowMeta = typeof workflowMetaSchema.infer;

const workflowDeploymentSchema = type({
  deploymentId: "string",
  kind: "string",
  status: "string",
  createdAt: "string",
  "meta?": workflowMetaSchema.or("null"),
});
export type WorkflowDeployment = typeof workflowDeploymentSchema.infer;
const workflowDeploymentListSchema = workflowDeploymentSchema.array();

// The run list is static once every run is terminal (or there are none) — a new
// run only appears via a mutation that invalidates the query. Poll only while
// something is still advancing so the app frame stops hitting the endpoint every
// 5s forever when nothing is running.
export function runListIsActive(runs: readonly { status: string }[]): boolean {
  return runs.some((r) => !isRecordTerminal(r.status as RunRecord["status"]));
}

export function useWorkflowRuns(tenantId?: string | null) {
  return useQuery<WorkflowRun[]>({
    queryKey: ["workflow-runs", tenantId ?? null],
    refetchInterval: (query) => {
      const runs = query.state.data;
      return runs && runListIsActive(runs) ? 5000 : false;
    },
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        withTenant("/workflow-exec/records", tenantId),
      );
      const parsed = workflowRunListSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(
          `Unexpected workflow-records response: ${parsed.summary}`,
        );
      }
      return parsed;
    },
  });
}

export function useWorkflowDeployments(
  tenantId?: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery<WorkflowDeployment[]>({
    queryKey: ["workflow-deployments", tenantId ?? null],
    staleTime: 5 * 60_000,
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        withTenant("/workflow-runs", tenantId),
      );
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
export function useWorkflowRecord(
  runId: string | null,
  tenantId?: string | null,
) {
  return useQuery<RunRecord>({
    queryKey: ["workflow-record", runId, tenantId ?? null],
    enabled: !!runId,
    staleTime: 0,
    // A forbidden/missing record is not transient — don't retry it on the poll
    // cadence (that turned a single 403 into a steady stream against one record).
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 2000 : false,
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        withTenant(`/workflow-exec/records/${runId as string}`, tenantId),
      );
      return parseRunRecord(raw);
    },
  });
}

// Log-derived run state (CL-2669 Phase 1b). Reads the run's authoritative
// per-step state folded from its native git event log, replacing the coarse
// record projection as the stepper's source of truth. Gated on a present runId;
// polls every 2s while the run is non-terminal and stops the instant it settles
// (completed/failed/cancelled) — a parked `awaiting-signal` gate keeps polling,
// since the log phase (not a separate record status) tells us the run is live.
// staleTime 0 so a resume's fresh state is never served stale. SSE is a later
// ticket; this poll is the interim cadence.
export function useWorkflowRunState(
  runId: string | null,
  tenantId?: string | null,
) {
  return useQuery<LogRunState>({
    queryKey: ["workflow-run-state", runId, tenantId ?? null],
    enabled: !!runId,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && !isLogStateTerminal(data.phase) ? 2000 : false;
    },
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        withTenant(`/workflow-exec/runs/${runId as string}/state`, tenantId),
      );
      const parsed = logRunStateSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(
          `Unexpected workflow run-state response: ${parsed.summary}`,
        );
      }
      return parsed;
    },
  });
}

export {
  runStateFromLog,
  runStateFromRecord,
  reconcileRunState,
  runWasInterrupted,
};

// Resolved step outputs for a run, decoded from the run-keyed log-derived
// /state fold (CL-2704). The legacy deployment-keyed
// /workflow-runs/:deploymentId/steps read 404s under per-run deployments
// (CL-2582), so outputs are mapped straight off the RunState this run's
// `useWorkflowRunState` query already polls — same cache entry, no second
// request, same 2s-while-active cadence.
export function useWorkflowStepOutputs(
  runId: string | null,
  tenantId?: string | null,
) {
  const state = useWorkflowRunState(runId, tenantId);
  const data = useMemo(
    () =>
      state.data === undefined ? undefined : stepOutputsFromLog(state.data),
    [state.data],
  );
  return { ...state, data };
}

export function useStartWorkflow(tenantId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, input }: { kind: string; input: unknown }) => {
      const raw = await api<unknown>(
        "POST",
        withTenant(
          `/workflow-exec/${encodeURIComponent(kind)}/start`,
          tenantId,
        ),
        { input },
      );
      return parseRunRecord(raw);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflow-runs"] });
    },
  });
}

// Resume a gated run: posts the gate signal and writes the returned fresh record
// straight into the record query cache so the panel advances without waiting for
// the next poll. The active gate is parked, so polling is off until this fires.
//
// `onMutate` optimistically flips the parked record from `awaiting` to `running`
// (keeping `currentStepId` so the panel stays on the same gate screen) the instant
// the user submits. The gate's step phase then reads as `in-flight`, which keeps
// the control disabled — server-guided, no client submit flag — and re-arms
// polling (refetchInterval gates on `running`). `onError` rolls the snapshot back
// so a failed submit re-enables the control for retry. `onSuccess` still writes
// the fresh record so the panel advances without waiting for the next poll.
export function useResumeWorkflow(runId: string, tenantId?: string | null) {
  const queryClient = useQueryClient();
  const queryKey = ["workflow-record", runId, tenantId ?? null] as const;
  return useMutation({
    mutationFn: async ({
      signalName,
      payload,
    }: {
      signalName: string;
      payload?: unknown;
    }) => {
      const raw = await api<unknown>(
        "POST",
        withTenant(
          `/workflow-exec/records/${encodeURIComponent(runId)}/resume`,
          tenantId,
        ),
        { signalName, payload },
      );
      return parseRunRecord(raw);
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<RunRecord>(queryKey);
      if (previous?.status === "awaiting") {
        queryClient.setQueryData<RunRecord>(queryKey, {
          ...previous,
          status: "running",
        });
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSuccess: (record) => {
      queryClient.setQueryData(queryKey, record);
    },
  });
}

// Archive a run (CL-2629): stops it, tears its per-run deployment down, and
// soft-deletes the record server-side. On success the run drops out of
// ["workflow-runs"], so invalidate that list to re-render without it.
export function useArchiveWorkflowRun(tenantId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => {
      await api<{ archived: true }>(
        "POST",
        withTenant(
          `/workflow-exec/records/${encodeURIComponent(runId)}/archive`,
          tenantId,
        ),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflow-runs"] });
    },
  });
}

const workflowCredentialSchema = type({
  id: "string",
  name: "string",
  providerName: "string",
  providerPlugin: "string",
  "model?": "string",
});
export type WorkflowCredential = typeof workflowCredentialSchema.infer;

export function useWorkflowCredentials(tenantId?: string | null) {
  return useQuery<WorkflowCredential[]>({
    queryKey: ["workflow-credentials", tenantId ?? null],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        withTenant("/workflow-exec/credentials", tenantId),
      );
      const parsed = workflowCredentialSchema.array()(raw);
      if (parsed instanceof type.errors) {
        throw new Error(
          `Unexpected workflow-credentials response: ${parsed.summary}`,
        );
      }
      return parsed;
    },
  });
}
