import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";

import { schema } from "../db";
import type { HubDb } from "../db";
import {
  getUsageByWorkflowRun,
  getWorkflowRunTokenTotals,
} from "./activity-overview";

// CL-2809: per-RUN token attribution, read-side over the existing analytics
// rollup. Mirrors the CL-2705/CL-2711 exercise in cl2705-attribution but keys
// the collapse on `workflow_run_record.id` (the runId) instead of the owning
// principal — proving the same `ins_<deploymentId>` join can recover per-run
// identity, and that the documented legacy caveat (a shared pre-CL-2582
// deployment collapses to its most-recent runner) drops the earlier run's
// usage rather than duplicating it across both rows.

const TENANT = "tn-run-tokens";
let client: PGlite;
let db: HubDb;
let seq = 0;

async function rollup(instanceId: string, inp: number, out: number) {
  seq += 1;
  await client.query(
    `insert into analytics_rollup_daily (id, tenant_id, instance_id, bucket_date, rollup_key, turn_count, tool_call_count, input_tokens, output_tokens)
     values ($1,$2,$3,'2026-07-01',$1,1,0,$4,$5)`,
    [`r-${seq}`, TENANT, instanceId, inp, out],
  );
}
async function instance(id: string, address: string) {
  await client.query(
    `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status)
     values ($1,'agt-x',$2,'prn-def',$3,'running')`,
    [id, TENANT, address],
  );
}
async function record(id: string, dep: string, createdAt: string) {
  await client.query(
    `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at)
     values ($1,$2,'last30days',$3,'prn-runner','completed',$4,$4)`,
    [id, dep, TENANT, createdAt],
  );
}

beforeAll(async () => {
  client = new PGlite();
  const b = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, b as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = b as unknown as HubDb;
});
afterAll(async () => await client?.close());
beforeEach(async () => {
  seq = 0;
  for (const t of [
    "member_agent_instance",
    "agent_instance",
    "workflow_run_record",
    "analytics_rollup_daily",
  ])
    await client.exec(`DELETE FROM "${t}";`);
});

describe("CL-2809 per-run workflow token attribution", () => {
  test("a live (post-CL-2582) 1:1 run<->deployment attributes its rollup tokens to its own runId", async () => {
    await instance("ins_depA", "ins_depA@wb.local");
    await record("run-a", "depA", "2026-06-01T00:00:00Z");
    await rollup("ins_depA", 300, 120);

    const rows = await getUsageByWorkflowRun({ db, tenantId: TENANT });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "run-a",
      inputTokens: 300,
      outputTokens: 120,
    });

    const solo = await getWorkflowRunTokenTotals({
      db,
      tenantId: TENANT,
      runId: "run-a",
    });
    expect(solo).toMatchObject({
      runId: "run-a",
      inputTokens: 300,
      outputTokens: 120,
    });
  });

  test("two independent live runs on two independent deployments never cross-attribute", async () => {
    await instance("ins_depA", "ins_depA@wb.local");
    await instance("ins_depB", "ins_depB@wb.local");
    await record("run-a", "depA", "2026-06-01T00:00:00Z");
    await record("run-b", "depB", "2026-06-02T00:00:00Z");
    await rollup("ins_depA", 100, 50);
    await rollup("ins_depB", 400, 200);

    const rows = await getUsageByWorkflowRun({ db, tenantId: TENANT });
    const byId = new Map(rows.map((r) => [r.runId, r]));
    expect(byId.get("run-a")).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(byId.get("run-b")).toMatchObject({
      inputTokens: 400,
      outputTokens: 200,
    });
  });

  test("legacy shared deployment with TWO run records: tokens collapse to the most-recent runId, the earlier run has NO attributable totals (not duplicated)", async () => {
    await instance("ins_depShared", "ins_depShared@wb.local");
    // Two serial runs on ONE deployment (pre-CL-2582 model).
    await record("run-early", "depShared", "2026-06-01T00:00:00Z");
    await record("run-late", "depShared", "2026-06-30T00:00:00Z");
    await rollup("ins_depShared", 1000, 1000);

    const rows = await getUsageByWorkflowRun({ db, tenantId: TENANT });

    // Pins the documented legacy caveat: the whole 2000 tokens land on the
    // MOST-RECENT run only. The earlier run is not a second, duplicated row —
    // it is absent entirely, so a caller cannot double-count or silently
    // misattribute its usage to the wrong run.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "run-late",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(rows.find((r) => r.runId === "run-early")).toBeUndefined();

    const early = await getWorkflowRunTokenTotals({
      db,
      tenantId: TENANT,
      runId: "run-early",
    });
    expect(early).toBeNull();

    const late = await getWorkflowRunTokenTotals({
      db,
      tenantId: TENANT,
      runId: "run-late",
    });
    expect(late).toMatchObject({ inputTokens: 1000, outputTokens: 1000 });
  });

  test("a run with no attributable instance/rollup returns null, not zero", async () => {
    await record("run-orphan", "depOrphan", "2026-06-01T00:00:00Z");
    // No agent_instance and no rollup row for depOrphan at all.

    const totals = await getWorkflowRunTokenTotals({
      db,
      tenantId: TENANT,
      runId: "run-orphan",
    });
    expect(totals).toBeNull();
  });

  test("scopes strictly to the requesting tenant", async () => {
    await client.query(
      `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status)
       values ('ins_depOther','agt-x','tn-other','prn-def','ins_depOther@wb.local','running')`,
    );
    await client.query(
      `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at)
       values ('run-other','depOther','last30days','tn-other','prn-runner','completed','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z')`,
    );
    await client.query(
      `insert into analytics_rollup_daily (id, tenant_id, instance_id, bucket_date, rollup_key, turn_count, tool_call_count, input_tokens, output_tokens)
       values ('r-other','tn-other','ins_depOther','2026-07-01','r-other',1,0,999,999)`,
    );

    const rows = await getUsageByWorkflowRun({ db, tenantId: TENANT });
    expect(rows).toHaveLength(0);

    const totals = await getWorkflowRunTokenTotals({
      db,
      tenantId: TENANT,
      runId: "run-other",
    });
    expect(totals).toBeNull();
  });
});
