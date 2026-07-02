import { and, eq, inArray, isNull } from "drizzle-orm";
import { type } from "arktype";
import { type Context } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { workflowRunRecord } from "../db/schema";
import {
  loadRunRecord,
  markRunStopped,
  type RunState,
} from "../workflow-executor/run-store";

const log = getLogger(["api", "workflow-run-abort"]);

// The only run states a run can be aborted FROM. Terminal runs
// (completed/failed) are left untouched; aborting them is a no-op.
const ACTIVE_STATUSES = ["running", "awaiting"] as const;

const AbortResponse = type({ runId: "string", status: "'failed'" });
const AbortActiveResponse = type({ aborted: "number", ids: "string[]" });
const ErrorResponse = type({ error: "string" });

// Dependencies for the operator abort handlers. Mark-terminal is the source of
// truth; the sidecar cancel is best-effort and is intentionally omitted —
// see the abort handler comment for why there is no per-run sidecar cancel.
export interface WorkflowRunAbortDeps {
  db: HubDb;
}

// Mark a single run terminal (status:'failed'). CL-2248's boot-reconciler reaps
// the run's sidecar dir on next restart once the record is terminal (this also
// clears a CL-2261 corrupt-log run). The record mark is the source of truth; the
// abort reason is not persisted (the log is the source of truth for run detail,
// CL-2669).
//
// Best-effort sidecar cancel: the runtime emits `RunCancelled` (which the
// projection bridge already folds → 'failed'), but the SidecarRouter exposes no
// per-RUN cancel — only `sendDrain(agentAddress, deadlineMs)`, which drains the
// whole DEPLOYMENT and would over-cancel sibling runs sharing that supervisor.
// Using it to abort one run is the wrong granularity, so we mark-terminal-only
// and let the boot-reconciler reclaim the dir. If a per-run cancel is added
// upstream, call it here (address = deriveDeploymentAddress, like /resume).
async function markRunAborted(db: HubDb, state: RunState): Promise<void> {
  await markRunStopped(db, state);
}

// DELETE /workflow-exec/records/:runId — abort one run. Operator-gated upstream
// (the same session grant guard as /workflows/deploy); an operator can abort ANY
// run, so there is no per-user ownership check here. 404 on an unknown run.
export function abortRunHandler(
  deps: WorkflowRunAbortDeps,
): (c: Context) => Promise<Response> {
  return async (c) => {
    const runId = c.req.param("runId");
    if (!runId) return c.json({ error: "runId is required" }, 400);
    const state = await loadRunRecord(deps.db, runId);
    if (!state) return c.json({ error: "run not found" }, 404);

    await markRunAborted(deps.db, state);
    log.info("workflow run aborted by operator", { runId, kind: state.kind });
    return c.json({ runId, status: "failed" as const });
  };
}

// POST /workflow-exec/records/abort-active — bulk-abort every active
// (running/awaiting) run, with optional `?kind=` and `?tenantId=` filters.
// Completed/failed runs are left untouched. Returns the count + ids aborted.
export function abortActiveRunsHandler(
  deps: WorkflowRunAbortDeps,
): (c: Context) => Promise<Response> {
  return async (c) => {
    const kind = c.req.query("kind");
    const tenantId = c.req.query("tenantId");

    const conditions = [
      inArray(workflowRunRecord.status, [...ACTIVE_STATUSES]),
      isNull(workflowRunRecord.deletedAt),
    ];
    if (kind !== undefined && kind !== "") {
      conditions.push(eq(workflowRunRecord.kind, kind));
    }
    if (tenantId !== undefined && tenantId !== "") {
      conditions.push(eq(workflowRunRecord.tenantId, tenantId));
    }

    const rows = await deps.db
      .select({ id: workflowRunRecord.id })
      .from(workflowRunRecord)
      .where(and(...conditions));

    const ids: string[] = [];
    for (const row of rows) {
      const state = await loadRunRecord(deps.db, row.id);
      if (!state) continue;
      await markRunAborted(deps.db, state);
      ids.push(row.id);
    }

    log.info("workflow runs bulk-aborted by operator", {
      aborted: ids.length,
      kind: kind ?? null,
      tenantId: tenantId ?? null,
    });
    return c.json({ aborted: ids.length, ids });
  };
}

export const abortRunRouteDescription = describeRoute({
  tags: ["Workflows"],
  summary: "Abort a workflow run",
  description:
    "Operator-gated. Marks the run terminal (status:'failed') so the boot-reconciler reaps its sidecar dir on next restart. An operator can abort ANY run. Best-effort sidecar cancel is omitted — there is no per-run cancel primitive (see code).",
  parameters: [
    {
      name: "runId",
      in: "path",
      required: true,
      description: "Run id (wfr_…) to abort.",
      schema: { type: "string" },
    },
  ],
  responses: {
    200: {
      description: "Run aborted",
      content: { "application/json": { schema: resolver(AbortResponse) } },
    },
    400: {
      description: "Missing runId",
      content: { "application/json": { schema: resolver(ErrorResponse) } },
    },
    403: {
      description: "Forbidden — caller is not an operator",
      content: { "application/json": { schema: resolver(ErrorResponse) } },
    },
    404: {
      description: "Run not found",
      content: { "application/json": { schema: resolver(ErrorResponse) } },
    },
  },
});

export const abortActiveRunsRouteDescription = describeRoute({
  tags: ["Workflows"],
  summary: "Abort all active workflow runs",
  description:
    "Operator-gated. Bulk-aborts every running/awaiting run (marks each terminal). Optional `?kind=` and `?tenantId=` filters. Completed/failed runs are untouched. Returns the count + ids aborted.",
  parameters: [
    {
      name: "kind",
      in: "query",
      required: false,
      description: "Only abort runs of this workflow kind.",
      schema: { type: "string" },
    },
    {
      name: "tenantId",
      in: "query",
      required: false,
      description: "Only abort runs in this tenant.",
      schema: { type: "string" },
    },
  ],
  responses: {
    200: {
      description: "Active runs aborted",
      content: {
        "application/json": { schema: resolver(AbortActiveResponse) },
      },
    },
    403: {
      description: "Forbidden — caller is not an operator",
      content: { "application/json": { schema: resolver(ErrorResponse) } },
    },
  },
});
