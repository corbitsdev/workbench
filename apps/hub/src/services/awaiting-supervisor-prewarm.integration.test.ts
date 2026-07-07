import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";

import { schema } from "../db";
import type { HubDb } from "../db";
import { workflowRun, workflowRunRecord } from "../db/schema";
import type { EnsureDeploymentRoutableFn } from "../routes/workflow-runs";
import { createWorkflowReconciler } from "./workflow-reconciler";

// CL-2756: the proactive awaiting-supervisor pre-warm, exercised over a real
// (PGlite) Postgres so the awaiting-scope predicate (`WHERE status = 'awaiting'`)
// round-trips for real. This is THE guard of the ticket: only a GATE-PARKED
// (`awaiting`) run whose supervisor is unroutable is pre-warmed — a `running`
// run (handled by the liveness sweep / reconnect reconcile, never resurrected by
// the periodic backstop) must NEVER be pre-warmed, or the periodic sweep would
// reintroduce the churn the per-run/eviction model exists to prevent.

const DEPLOYMENT_DOMAIN = "wf.localhost";
const TENANT = "tn-prewarm";
const KIND = "attio-task";
const DEPLOYER = "prn-deployer";

const WORKFLOW_RUN_DDL = `
  CREATE TABLE workflow_run (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id text,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    input jsonb,
    output jsonb,
    meta jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp
  );
`;

const WORKFLOW_RUN_RECORD_DDL = `
  CREATE TABLE workflow_run_record (
    id text PRIMARY KEY,
    deployment_id text,
    kind text NOT NULL,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    status text NOT NULL DEFAULT 'running',
    input jsonb,
    origin_conversation_id text,
    started_at timestamp,
    ended_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp
  );
`;

let client: PGlite;
let db: HubDb;

// A published-definition registry row supplies the DEPLOY principal per
// kind+tenant (the record's own principal is the run OWNER, not the deployer).
async function seedRegistry(): Promise<void> {
  await db.insert(workflowRun).values({
    deploymentId: "ses_op_shared",
    tenantId: TENANT,
    principalId: DEPLOYER,
    kind: KIND,
    status: "deployed",
  });
}

async function seedRecord(
  runId: string,
  deploymentId: string | null,
  status: string,
  opts: { kind?: string } = {},
): Promise<void> {
  await db.insert(workflowRunRecord).values({
    id: runId,
    deploymentId,
    kind: opts.kind ?? KIND,
    tenantId: TENANT,
    principalId: "prn-runner",
    status: status as never,
  });
}

function addressOf(deploymentId: string): string {
  return deriveDeploymentAddress({
    deploymentId,
    deploymentDomain: DEPLOYMENT_DOMAIN,
  });
}

// Capture every ensureDeploymentRoutable call so a test asserts EXACTLY which
// deployments the sweep re-established — the awaiting-scope proof.
function makeReconciler(routable: string[]) {
  const calls: string[] = [];
  const ensure: EnsureDeploymentRoutableFn = (args) => {
    calls.push(args.deploymentId);
    return Promise.resolve({ reestablished: true });
  };
  const reconciler = createWorkflowReconciler({
    db,
    events: { on: () => () => {} } as never,
    ensureDeploymentRoutable: ensure,
    getRoutableAddresses: () => routable,
    deploymentDomain: DEPLOYMENT_DOMAIN,
    reclaimDeployment: () => Promise.resolve(),
  });
  return { reconciler, calls };
}

beforeEach(async () => {
  client = new PGlite();
  await client.exec(WORKFLOW_RUN_DDL);
  await client.exec(WORKFLOW_RUN_RECORD_DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
  await seedRegistry();
});

afterEach(async () => {
  await client?.close();
});

describe("reconcileAwaiting — proactive awaiting-supervisor pre-warm (CL-2756)", () => {
  test("re-establishes an AWAITING run whose supervisor is unroutable, using the DEPLOY principal", async () => {
    await seedRecord("parked", "ses_run_parked", "awaiting");
    const { reconciler, calls } = makeReconciler([]);

    const summary = await reconciler.reconcileAwaiting();

    expect(calls).toEqual(["ses_run_parked"]);
    expect(summary.reestablished).toBe(1);
    expect(summary.alreadyRoutable).toBe(0);
  });

  test("does NOT pre-warm a RUNNING unroutable run (awaiting-scope guard — the #1 invariant)", async () => {
    await seedRecord("live", "ses_run_live", "running");
    const { reconciler, calls } = makeReconciler([]);

    const summary = await reconciler.reconcileAwaiting();

    expect(calls).toEqual([]);
    expect(summary.reestablished).toBe(0);
    expect(summary.candidates).toBe(0);
  });

  test("is a no-op for an AWAITING run whose supervisor is ALREADY routable (no duplicate establish)", async () => {
    await seedRecord("parked", "ses_run_parked", "awaiting");
    const { reconciler, calls } = makeReconciler([addressOf("ses_run_parked")]);

    const summary = await reconciler.reconcileAwaiting();

    expect(calls).toEqual([]);
    expect(summary.reestablished).toBe(0);
    expect(summary.alreadyRoutable).toBe(1);
  });

  test("mixed batch: pre-warms ONLY the unroutable awaiting run, never the running or the routable-awaiting one", async () => {
    await seedRecord("parked-gone", "ses_parked_gone", "awaiting");
    await seedRecord("parked-warm", "ses_parked_warm", "awaiting");
    await seedRecord("running-gone", "ses_running_gone", "running");
    await seedRecord("done", "ses_done", "completed");
    const { reconciler, calls } = makeReconciler([
      addressOf("ses_parked_warm"),
    ]);

    const summary = await reconciler.reconcileAwaiting();

    expect(calls).toEqual(["ses_parked_gone"]);
    expect(summary.candidates).toBe(2); // both awaiting; completed excluded
    expect(summary.reestablished).toBe(1);
    expect(summary.alreadyRoutable).toBe(1);
  });

  test("dedups multiple awaiting records that share one deploymentId (single establish)", async () => {
    // A per-run deployment is 1:1 with a run, but the sweep must not double-drive
    // a deployment if two awaiting records ever point at the same deploymentId —
    // the `seen` set collapses them to one candidate + one establish.
    await seedRecord("parked-a", "ses_shared", "awaiting");
    await seedRecord("parked-b", "ses_shared", "awaiting");
    const { reconciler, calls } = makeReconciler([]);

    const summary = await reconciler.reconcileAwaiting();

    expect(calls).toEqual(["ses_shared"]);
    expect(summary.candidates).toBe(1);
    expect(summary.reestablished).toBe(1);
  });

  test("skips an awaiting run whose kind has no registry row (deploy principal unrecoverable)", async () => {
    await seedRecord("orphan", "ses_run_orphan", "awaiting", {
      kind: "undeployed-kind",
    });
    const { reconciler, calls } = makeReconciler([]);

    const summary = await reconciler.reconcileAwaiting();

    expect(calls).toEqual([]);
    expect(summary.skippedNoPrincipal).toBe(1);
    expect(summary.reestablished).toBe(0);
  });

  test("ignores a soft-deleted awaiting record", async () => {
    await seedRecord("archived", "ses_run_archived", "awaiting");
    await db
      .update(workflowRunRecord)
      .set({ deletedAt: new Date() })
      .where(eq(workflowRunRecord.id, "archived"));
    const { reconciler, calls } = makeReconciler([]);

    const summary = await reconciler.reconcileAwaiting();

    expect(calls).toEqual([]);
    expect(summary.candidates).toBe(0);
  });
});
