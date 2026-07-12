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
  getWorkflowRunStepTokenTotals,
  getWorkflowRunTokenTotals,
} from "./activity-overview";

const TENANT = "tn-step-tokens";
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
async function record(id: string, dep: string) {
  await client.query(
    `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at)
     values ($1,$2,'demo-flow',$3,'prn-runner','completed','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z')`,
    [id, dep, TENANT],
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
    "agent_instance",
    "workflow_run_record",
    "analytics_rollup_daily",
  ])
    await client.exec(`DELETE FROM "${t}";`);
});

describe("CL-2819 per-step workflow token attribution", () => {
  test("attributes rollups on ins_<dep>-<stepId>@ instances to that stepId", async () => {
    await instance("ins_dep-super", "ins_dep@wb.local");
    await instance("ins_dep-draft", "ins_dep-draft@wb.local");
    await instance("ins_dep-polish", "ins_dep-polish@wb.local");
    await record("run-1", "dep");
    await rollup("ins_dep-super", 50, 10);
    await rollup("ins_dep-draft", 200, 40);
    await rollup("ins_dep-polish", 30, 5);

    const steps = await getWorkflowRunStepTokenTotals({
      db,
      tenantId: TENANT,
      runId: "run-1",
    });
    expect(steps).toHaveLength(2);
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: "draft", inputTokens: 200 }),
        expect.objectContaining({ stepId: "polish", inputTokens: 30 }),
      ]),
    );

    const runTotal = await getWorkflowRunTokenTotals({
      db,
      tenantId: TENANT,
      runId: "run-1",
    });
    expect(runTotal?.inputTokens).toBe(280);
  });

  test("does not attribute step usage to an older run when a newer run shares the deployment", async () => {
    await instance("ins_shared-draft", "ins_shared-draft@wb.local");
    await client.query(
      `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at)
       values ('run-old','shared','demo-flow',$1,'prn-runner','completed','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z')`,
      [TENANT],
    );
    await client.query(
      `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at)
       values ('run-new','shared','demo-flow',$1,'prn-runner','completed','2026-07-01T00:00:00Z','2026-07-01T00:00:00Z')`,
      [TENANT],
    );
    await rollup("ins_shared-draft", 99, 11);

    const olderSteps = await getWorkflowRunStepTokenTotals({
      db,
      tenantId: TENANT,
      runId: "run-old",
    });
    expect(olderSteps).toEqual([]);

    const newerSteps = await getWorkflowRunStepTokenTotals({
      db,
      tenantId: TENANT,
      runId: "run-new",
    });
    expect(newerSteps).toEqual([
      expect.objectContaining({ stepId: "draft", inputTokens: 99 }),
    ]);
  });

  test("returns empty when the run has no deploymentId", async () => {
    await client.query(
      `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at)
       values ('run-null',null,'demo-flow',$1,'prn-runner','completed','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z')`,
      [TENANT],
    );
    const steps = await getWorkflowRunStepTokenTotals({
      db,
      tenantId: TENANT,
      runId: "run-null",
    });
    expect(steps).toEqual([]);
  });
});
