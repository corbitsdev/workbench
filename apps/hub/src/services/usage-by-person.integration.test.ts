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

// Real-Postgres (PGlite, in-process wasm) exercise of the CL-2705 workflow
// attribution fallback in `getUsageByPerson`. The interesting behaviour — a
// per-run workflow instance carries the definition's synthetic principal and no
// `member_agent_instance` mapping, so its usage must be resolved through
// `workflow_run_record.principalId` (the human) via the `ins_<deploymentId>`
// address convention — lives entirely in SQL (two DISTINCT ON subqueries left-
// joined with a coalesce + IS NOT NULL filter), so the mocked-chain unit tests
// cannot prove it. This pushes the real schema and asserts genuine attribution
// + exclusion.

const TENANT = "tn-usage";
const OTHER_TENANT = "tn-usage-other";

let client: PGlite;
let db: HubDb;

const SEEDED_TABLES = [
  "member_agent_instance",
  "agent_instance",
  "workflow_run_record",
  "analytics_rollup_daily",
];

let rollupSeq = 0;

async function seedRollup(args: {
  instanceId: string;
  tenantId?: string;
  inputTokens: number;
  outputTokens: number;
  turnCount?: number;
  toolCallCount?: number;
}): Promise<void> {
  rollupSeq += 1;
  await client.query(
    `insert into analytics_rollup_daily
       (id, tenant_id, instance_id, bucket_date, rollup_key, turn_count, tool_call_count, input_tokens, output_tokens)
     values ($1, $2, $3, '2026-07-01', $1, $4, $5, $6, $7)`,
    [
      `rollup-${rollupSeq}`,
      args.tenantId ?? TENANT,
      args.instanceId,
      args.turnCount ?? 1,
      args.toolCallCount ?? 0,
      args.inputTokens,
      args.outputTokens,
    ],
  );
}

async function seedInstance(args: {
  instanceId: string;
  syntheticPrincipalId: string;
  address: string;
  tenantId?: string;
}): Promise<void> {
  await client.query(
    `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status)
     values ($1, 'agt-x', $2, $3, $4, 'running')`,
    [
      args.instanceId,
      args.tenantId ?? TENANT,
      args.syntheticPrincipalId,
      args.address,
    ],
  );
}

async function seedMemberMapping(args: {
  instanceId: string;
  memberPrincipalId: string;
  tenantId?: string;
}): Promise<void> {
  await client.query(
    `insert into member_agent_instance (id, tenant_id, member_principal_id, template_key, agent_id, instance_id)
     values ('link-' || $1, $2, $3, 'myra', 'agt-x', $1)`,
    [args.instanceId, args.tenantId ?? TENANT, args.memberPrincipalId],
  );
}

async function seedRunRecord(args: {
  id: string;
  deploymentId: string;
  principalId: string;
  tenantId?: string;
  deleted?: boolean;
}): Promise<void> {
  await client.query(
    `insert into workflow_run_record (id, deployment_id, kind, tenant_id, principal_id, status, created_at, updated_at, deleted_at)
     values ($1, $2, 'last30days', $3, $4, 'completed', now(), now(), $5)`,
    [
      args.id,
      args.deploymentId,
      args.tenantId ?? TENANT,
      args.principalId,
      args.deleted === true ? new Date().toISOString() : null,
    ],
  );
}

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  rollupSeq = 0;
  for (const table of SEEDED_TABLES) {
    await client.exec(`DELETE FROM "${table}";`);
  }
});

describe("getUsageByPerson — workflow attribution through the run record (CL-2705)", () => {
  test("attributes a per-run workflow instance's usage to the human on workflow_run_record, not its synthetic principal", async () => {
    // A workflow per-run deployment: supervisor instance addressed
    // `ins_<deploymentId>@…`, owned by the DEFINITION's synthetic principal,
    // with NO member_agent_instance mapping. The human lives only on the run
    // record.
    await seedInstance({
      instanceId: "ins_dep1",
      syntheticPrincipalId: "prn-workflow-def",
      address: "ins_dep1@wb.local",
    });
    await seedRunRecord({
      id: "run-1",
      deploymentId: "dep1",
      principalId: "prn-human-runner",
    });
    await seedRollup({
      instanceId: "ins_dep1",
      inputTokens: 500,
      outputTokens: 200,
      toolCallCount: 3,
    });

    const rows = await getUsageByPerson({
      db,
      tenantId: TENANT,
      callerPrincipalId: "prn-human-runner",
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.principalId).toBe("prn-human-runner");
    // NOT the synthetic definition principal.
    expect(row?.principalId).not.toBe("prn-workflow-def");
    expect(row?.inputTokens).toBe(500);
    expect(row?.outputTokens).toBe(200);
    expect(row?.toolCallCount).toBe(3);
    expect(row?.isSelf).toBe(true);
  });

  test("prefers an explicit member_agent_instance mapping and leaves a mapping-less, run-less instance unattributed", async () => {
    // Mapped Myra-style instance → member A.
    await seedInstance({
      instanceId: "ins-myra",
      syntheticPrincipalId: "prn-synth-myra",
      address: "ins-myra@wb.local",
    });
    await seedMemberMapping({
      instanceId: "ins-myra",
      memberPrincipalId: "prn-member-a",
    });
    await seedRollup({
      instanceId: "ins-myra",
      inputTokens: 100,
      outputTokens: 50,
    });

    // Workflow per-run instance → human B via run record.
    await seedInstance({
      instanceId: "ins_dep9",
      syntheticPrincipalId: "prn-workflow-def",
      address: "ins_dep9@wb.local",
    });
    await seedRunRecord({
      id: "run-9",
      deploymentId: "dep9",
      principalId: "prn-member-b",
    });
    await seedRollup({
      instanceId: "ins_dep9",
      inputTokens: 400,
      outputTokens: 100,
    });

    // Shared/system instance: no mapping, no workflow run record. Its usage must
    // NOT surface (cleanly unattributed, not a crash, not force-assigned).
    await seedInstance({
      instanceId: "ins-shared",
      syntheticPrincipalId: "prn-shared-agent",
      address: "ins-shared@wb.local",
    });
    await seedRollup({
      instanceId: "ins-shared",
      inputTokens: 9999,
      outputTokens: 9999,
    });

    const rows = await getUsageByPerson({
      db,
      tenantId: TENANT,
      callerPrincipalId: null,
    });

    const byPrincipal = new Map(rows.map((r) => [r.principalId, r]));
    // CL-2746: the mapping-less, run-less shared instance is not dropped — its
    // usage surfaces under the explicit Unattributed bucket, and its synthetic
    // principal is never used as a person.
    expect([...byPrincipal.keys()].sort()).toEqual([
      "prn-member-a",
      "prn-member-b",
      "unattributed",
    ]);
    expect(byPrincipal.get("prn-member-a")?.inputTokens).toBe(100);
    expect(byPrincipal.get("prn-member-b")?.inputTokens).toBe(400);
    // The shared agent's synthetic principal never appears as itself; its usage
    // is bucketed as Unattributed instead.
    expect(byPrincipal.has("prn-shared-agent")).toBe(false);
    expect(byPrincipal.get("unattributed")?.inputTokens).toBe(9999);
  });

  test("ignores a soft-deleted run record and a run record in another tenant", async () => {
    await seedInstance({
      instanceId: "ins_depDel",
      syntheticPrincipalId: "prn-workflow-def",
      address: "ins_depDel@wb.local",
    });
    await seedRunRecord({
      id: "run-del",
      deploymentId: "depDel",
      principalId: "prn-human-deleted",
      deleted: true,
    });
    await seedRollup({
      instanceId: "ins_depDel",
      inputTokens: 300,
      outputTokens: 300,
    });

    // A same-deployment run record owned by a different tenant must not bleed
    // attribution across the boundary.
    await seedInstance({
      instanceId: "ins_depX",
      syntheticPrincipalId: "prn-workflow-def",
      address: "ins_depX@wb.local",
    });
    await seedRunRecord({
      id: "run-x",
      deploymentId: "depX",
      principalId: "prn-foreign-human",
      tenantId: OTHER_TENANT,
    });
    await seedRollup({
      instanceId: "ins_depX",
      inputTokens: 700,
      outputTokens: 700,
    });

    const rows = await getUsageByPerson({
      db,
      tenantId: TENANT,
      callerPrincipalId: null,
    });

    // Neither the soft-deleted run's human nor the foreign-tenant run's human is
    // attributed. CL-2746: the in-tenant instance usage that cannot be tied to a
    // person is not dropped — it surfaces under the single Unattributed bucket
    // (300+700 in, 300+700 out), never against prn-human-deleted or
    // prn-foreign-human.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.principalId).toBe("unattributed");
    expect(rows[0]?.inputTokens).toBe(1000);
    expect(rows[0]?.outputTokens).toBe(1000);
  });
});
