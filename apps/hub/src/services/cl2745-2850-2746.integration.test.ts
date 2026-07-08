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
  getActivityOverview,
  getUsageByPerson,
  getUsageByWorkflowType,
  UNATTRIBUTED_PERSON_LABEL,
  UNATTRIBUTED_PERSON_PRINCIPAL_ID,
} from "./activity-overview";

const TENANT = "tn-insights-fixes";
let client: PGlite;
let db: HubDb;
let seq = 0;

async function rollup(instanceId: string, inp: number, out: number) {
  seq += 1;
  await client.query(
    `insert into analytics_rollup_daily (id, tenant_id, instance_id, bucket_date, rollup_key, turn_count, tool_call_count, input_tokens, output_tokens)
     values ($1,$2,$3,'2026-07-05',$1,1,0,$4,$5)`,
    [`r-${seq}`, TENANT, instanceId, inp, out],
  );
}

async function instance(id: string, address: string) {
  await client.query(
    `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status)
     values ($1,'agt-x',$2,'prn-synth',$3,'running')`,
    [id, TENANT, address],
  );
}

async function workflowRunRow(dep: string, kind: string) {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await client.query(
    `insert into workflow_run (id, deployment_id, tenant_id, principal_id, kind, status)
     values ($1,$2,$3,'prn-runner',$4,'completed')`,
    [id, dep, TENANT, kind],
  );
}

async function runRecord(
  id: string,
  dep: string,
  kind: string,
  createdAt: string,
) {
  await client.query(
    `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at)
     values ($1,$2,$3,$4,'prn-runner','completed',$5,$5)`,
    [id, dep, kind, TENANT, createdAt],
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
    "workflow_run",
    "agent_instance",
    "workflow_run_record",
    "analytics_rollup_daily",
  ])
    await client.exec(`DELETE FROM "${t}";`);
});

describe("CL-2745 deploymentId prefix boundary", () => {
  test("getUsageByWorkflowType does not attribute tokens across prefix-colliding deployment ids", async () => {
    await instance("ins_dep", "ins_dep@wb.local");
    await instance("ins_depmore", "ins_depmore@wb.local");
    await workflowRunRow("dep", "kind-short");
    await workflowRunRow("depmore", "kind-long");
    await rollup("ins_dep", 100, 0);
    await rollup("ins_depmore", 200, 0);

    const rows = await getUsageByWorkflowType({ db, tenantId: TENANT });
    const byKind = new Map(rows.map((r) => [r.kind, r.inputTokens]));
    expect(byKind.get("kind-short")).toBe(100);
    expect(byKind.get("kind-long")).toBe(200);
  });
});

describe("CL-2850 workflow run counts respect date range", () => {
  test("byKind and executionsStartedInRange align when range is bounded", async () => {
    await runRecord("run-old", "d1", "alpha", "2026-06-01T12:00:00Z");
    await runRecord("run-new", "d2", "beta", "2026-07-02T12:00:00Z");

    const overview = await getActivityOverview({
      db,
      tenantId: TENANT,
      range: { startDate: "2026-07-01", endDate: "2026-07-31" },
    });

    expect(overview.workflowRuns.executionsStartedInRange).toBe(1);
    expect(overview.workflowRuns.executionRecords).toBe(2);
    expect(overview.workflowRuns.byKind).toEqual([{ key: "beta", count: 1 }]);
  });
});

describe("CL-2746 Unattributed person bucket", () => {
  test("shared instance usage appears under Unattributed so person totals reconcile", async () => {
    await instance("ins_shared", "shared-agent@wb.local");
    await rollup("ins_shared", 50, 25);

    const rows = await getUsageByPerson({
      db,
      tenantId: TENANT,
      callerPrincipalId: null,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.principalId).toBe(UNATTRIBUTED_PERSON_PRINCIPAL_ID);
    expect(rows[0]?.name).toBe(UNATTRIBUTED_PERSON_LABEL);
    expect(rows[0]?.inputTokens).toBe(50);
    expect(rows[0]?.outputTokens).toBe(25);
  });
});
