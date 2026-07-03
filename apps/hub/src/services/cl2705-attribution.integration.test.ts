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
import { getUsageByPerson } from "./activity-overview";

const TENANT = "tn-repro";
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
async function mapping(instanceId: string, member: string) {
  await client.query(
    `insert into member_agent_instance (id, tenant_id, member_principal_id, template_key, agent_id, instance_id)
     values ('m-'||$1,$2,$3,'myra','agt-x',$1)`,
    [instanceId, TENANT, member],
  );
}
async function record(
  id: string,
  dep: string,
  principal: string,
  createdAt: string,
) {
  await client.query(
    `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at)
     values ($1,$2,'last30days',$3,$4,'completed',$5,$5)`,
    [id, dep, TENANT, principal, createdAt],
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

describe("CL-2705 workflow usage attribution", () => {
  test("legacy shared deployment with TWO run records by DIFFERENT principals: ALL usage attributes to the most-recent runner (CL-2711 documented behavior)", async () => {
    await instance("ins_dep-shared", "ins_dep-shared@wb.local");
    // Two serial runs on ONE deployment (pre-CL-2582 model), different humans.
    await record(
      "run-early",
      "dep-shared",
      "prn-alice",
      "2026-06-01T00:00:00Z",
    );
    await record("run-late", "dep-shared", "prn-bob", "2026-06-30T00:00:00Z");
    await rollup("ins_dep-shared", 1000, 1000);

    const rows = await getUsageByPerson({
      db,
      tenantId: TENANT,
      callerPrincipalId: null,
    });

    // Pins the documented CL-2711 behavior so a future refactor can't silently
    // change it: the whole 2000 tokens land on ONE principal, the most-recent
    // runner (bob), and the earlier runner (alice) is entirely absent.
    expect(rows).toHaveLength(1);
    const bob = rows.find((r) => r.principalId === "prn-bob");
    expect(bob).toBeDefined();
    expect(bob!.inputTokens + bob!.outputTokens).toBe(2000);
    expect(rows.find((r) => r.principalId === "prn-alice")).toBeUndefined();
  });

  test("instance with BOTH a mapping AND a run record: mapping wins, tokens counted once (not doubled)", async () => {
    await instance("ins_both", "ins_both@wb.local");
    await mapping("ins_both", "prn-mapping-owner");
    await record(
      "run-both",
      "both",
      "prn-record-owner",
      "2026-06-01T00:00:00Z",
    );
    await rollup("ins_both", 500, 500);

    const rows = await getUsageByPerson({
      db,
      tenantId: TENANT,
      callerPrincipalId: null,
    });

    const total = rows.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0);
    expect(total).toBe(1000);
    const owner = rows.find((r) => r.principalId === "prn-mapping-owner");
    expect(owner).toBeDefined();
    expect(owner!.inputTokens + owner!.outputTokens).toBe(1000);
    expect(
      rows.find((r) => r.principalId === "prn-record-owner"),
    ).toBeUndefined();
  });
});
