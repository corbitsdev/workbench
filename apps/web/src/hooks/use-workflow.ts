import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import { api, withDeployRetry } from "../lib/api";
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
  status: "'provisioning'|'running'|'awaiting'|'completed'|'failed'",
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

// A run row as returned by the conversation-scoped list (CL-2680). The list
// projection keeps `originConversationId` raw (string | null), unlike the
// single-record response which omits it when null.
const conversationRunSchema = type({
  runId: "string",
  kind: "string",
  status: "'provisioning'|'running'|'awaiting'|'completed'|'failed'",
  createdAt: "string",
  originConversationId: "string|null",
});
export type ConversationWorkflowRun = typeof conversationRunSchema.infer;
const conversationRunListSchema = conversationRunSchema.array();

export const CONVERSATION_RUN_POLL_MS = 5000;
export const CONVERSATION_RUN_IDLE_POLL_MS = 60_000;

// Poll cadence for the conversation run list: 5s while any listed run is still
// advancing; backed off to a slow idle tick when the list is empty or fully
// terminal. Discovery can't stop entirely — runs are started by producers the
// client never sees as a mutation (the workflow_start Myra tool stamps the
// thread id as originConversationId server-side), so the idle tick is what
// eventually surfaces a run started mid-conversation.
export function conversationRunPollInterval(
  runs: readonly { status: string }[] | undefined,
): number {
  if (runs === undefined || runListIsActive(runs)) {
    return CONVERSATION_RUN_POLL_MS;
  }
  return CONVERSATION_RUN_IDLE_POLL_MS;
}

// Runs surfaced in the chat workflow dock (CL-2680): every run whose
// originConversationId matches the open conversation (the Myra thread id).
// Gated off entirely when no conversation is open. Polls on the shared 5s list
// cadence while a run is live, backing off once the list goes quiescent; the
// per-run 2s state poll lives in `useWorkflowRunState` on each mounted card.
export function useConversationWorkflowRuns(
  conversationId: string | null,
  tenantId?: string | null,
) {
  return useQuery<ConversationWorkflowRun[]>({
    queryKey: ["conversation-workflow-runs", conversationId, tenantId ?? null],
    enabled: conversationId !== null && conversationId !== "",
    refetchInterval: (query) => conversationRunPollInterval(query.state.data),
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        withTenant(
          `/workflow-exec/records?originConversationId=${encodeURIComponent(conversationId as string)}`,
          tenantId,
        ),
      );
      const parsed = conversationRunListSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(
          `Unexpected conversation workflow-records response: ${parsed.summary}`,
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
    // Poll while the run is still starting (`provisioning`, CL-2755) or a step is
    // executing (`running`); stop once it parks on a gate or settles.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status === "provisioning" ? 2000 : false;
    },
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
// Shared query key + fetcher for a run's log-derived state, so the per-card
// `useWorkflowRunState` and the conversation-wide gate scan (`useQueries` in
// use-conversation-gates.ts) hit the SAME cache entry — one poll, not two.
export function workflowRunStateQueryKey(
  runId: string,
  tenantId?: string | null,
): readonly [string, string, string | null] {
  return ["workflow-run-state", runId, tenantId ?? null];
}

export async function fetchWorkflowRunState(
  runId: string,
  tenantId?: string | null,
): Promise<LogRunState> {
  const raw = await api<unknown>(
    "GET",
    withTenant(`/workflow-exec/runs/${runId}/state`, tenantId),
  );
  const parsed = logRunStateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Unexpected workflow run-state response: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function useWorkflowRunState(
  runId: string | null,
  tenantId?: string | null,
) {
  const queryClient = useQueryClient();
  return useQuery<LogRunState>({
    queryKey: ["workflow-run-state", runId, tenantId ?? null],
    enabled: !!runId,
    staleTime: 0,
    retry: false,
    // A transient first-fetch error must NOT permanently freeze the pane
    // (CL-2727): keep the poll armed whenever there is no data yet — first load
    // OR after an error — so a single early failure self-heals on the next tick
    // instead of disarming `refetchInterval` forever (the old `data && …` guard
    // returned false while `data` was undefined, wedging the poll). A genuine
    // parse error still surfaces immediately via `isError`; the interval simply
    // re-attempts.
    //
    // The INDEX status is authoritative for run-level terminal (CL-2727): an
    // operator abort or the hub liveness sweep writes `failed` only to the index
    // (`workflow_run_record`), never to the log — so `/state` (a pure log fold)
    // reports `running`/`pending` forever while `/runs` reports `failed`. Keying
    // the poll only on the log phase would poll `/state` indefinitely. Consult
    // the record cache first and stop the moment the index settles, even if the
    // log hasn't. The poll otherwise stops once the log itself settles.
    refetchInterval: (query) => {
      const record = queryClient.getQueryData<RunRecord>([
        "workflow-record",
        runId,
        tenantId ?? null,
      ]);
      if (record && isRecordTerminal(record.status)) return false;
      const data = query.state.data;
      if (!data) return 2000;
      return isLogStateTerminal(data.phase) ? false : 2000;
    },
    queryFn: () => fetchWorkflowRunState(runId as string, tenantId),
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

// A start/resume that lands during the deploy window (hub up, sidecar
// reconnecting) gets a 503 { code: "deploy_in_progress" } (CL-2707). Rather than
// flash an error, the mutation auto-retries with bounded backoff and calls
// `onRedeploying` before each wait so the caller can show an honest transient
// state; any other failure surfaces immediately.
export function useStartWorkflow(tenantId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      kind,
      input,
      onRedeploying,
    }: {
      kind: string;
      input: unknown;
      onRedeploying?: () => void;
    }) => {
      const raw = await withDeployRetry(
        () =>
          api<unknown>(
            "POST",
            withTenant(
              `/workflow-exec/${encodeURIComponent(kind)}/start`,
              tenantId,
            ),
            { input },
          ),
        onRedeploying ? { onRetrying: onRedeploying } : undefined,
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
      onRedeploying,
    }: {
      signalName: string;
      payload?: unknown;
      onRedeploying?: () => void;
    }) => {
      const raw = await withDeployRetry(
        () =>
          api<unknown>(
            "POST",
            withTenant(
              `/workflow-exec/records/${encodeURIComponent(runId)}/resume`,
              tenantId,
            ),
            { signalName, payload },
          ),
        onRedeploying ? { onRetrying: onRedeploying } : undefined,
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

// Resume a conversation's pending gate by runId (CL-2681). Unlike
// `useResumeWorkflow`, which binds a single runId at hook-call, this is a
// generic resume whose target run is chosen at submit time — the runId a free
// text reply routes to (single-gate) or a dock card button names (multi-gate)
// is only known at runtime. On success it invalidates both the run's index
// record and its log-state so the dock advances off the gate immediately.
//
// This mutation does NOT swallow failures — its promise rejects with the
// sanitized ApiError so callers can surface the reason (e.g. a stale-gate 409)
// and recover the user's text. Its `isPending` is only an effective double-fire
// guard when the caller gates on it: both the dock card (`onRespond`) and the
// chat surface (`resumeInFlight`) skip a second submit while a resume is in
// flight, so at most one resume fires per gate.
export function useResumeConversationGate(tenantId?: string | null) {
  const queryClient = useQueryClient();
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
    onSuccess: (record) => {
      queryClient.setQueryData(
        ["workflow-record", record.runId, tenantId ?? null],
        record,
      );
      void queryClient.invalidateQueries({
        queryKey: workflowRunStateQueryKey(record.runId, tenantId),
      });
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
