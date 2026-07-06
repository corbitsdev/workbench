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
import { getPrincipalRoster, getTenantRoster } from "./principal-roster";

// Real-Postgres exercise of the roster query across the workbench-owned
// member_agent_instance link, the intx agent_instance/agent identity, the
// per-instance agent_session count, and the workflow_run_record run index.
// FK enforcement is disabled for seeding so each test plants only the rows the
// query reads.

const TENANT = "tn-roster";
const OTHER_TENANT = "tn-other";
const MEMBER = "prn-member";
const OTHER_MEMBER = "prn-other-member";

let client: PGlite;
let db: HubDb;

const SEEDED_TABLES = [
  "member_agent_instance",
  "agent_instance",
  "agent",
  "agent_session",
  "workflow_run_record",
];

async function seedAgent(id: string, name: string): Promise<void> {
  await client.query(
    `insert into agent (id, tenant_id, creator_principal_id, name) values ($1, $2, 'prn-creator', $3)`,
    [id, TENANT, name],
  );
}

async function seedOwnedInstance(args: {
  instanceId: string;
  agentId: string;
  syntheticPrincipalId: string;
  memberPrincipalId?: string;
  tenantId?: string;
  status?: string;
}): Promise<void> {
  await client.query(
    `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status)
     values ($1, $2, $3, $4, $1 || '@wb.local', $5)`,
    [
      args.instanceId,
      args.agentId,
      args.tenantId ?? TENANT,
      args.syntheticPrincipalId,
      args.status ?? "running",
    ],
  );
  await client.query(
    `insert into member_agent_instance (id, tenant_id, member_principal_id, template_key, agent_id, instance_id)
     values ('link-' || $1, $2, $3, 'myra', $4, $1)`,
    [
      args.instanceId,
      args.tenantId ?? TENANT,
      args.memberPrincipalId ?? MEMBER,
      args.agentId,
    ],
  );
}

async function seedSession(args: {
  id: string;
  principalId: string;
  tenantId?: string;
}): Promise<void> {
  await client.query(
    `insert into agent_session (id, tenant_id, agent_id, principal_id, status, created_at, updated_at)
     values ($1, $2, 'agt-x', $3, 'active', now(), now())`,
    [args.id, args.tenantId ?? TENANT, args.principalId],
  );
}

async function seedRun(args: {
  id: string;
  principalId?: string;
  tenantId?: string;
  kind?: string;
  status?: string;
  createdAt?: string;
}): Promise<void> {
  await client.query(
    `insert into workflow_run_record (id, kind, tenant_id, principal_id, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())`,
    [
      args.id,
      args.kind ?? "last30days",
      args.tenantId ?? TENANT,
      args.principalId ?? MEMBER,
      args.status ?? "completed",
      args.createdAt ?? new Date().toISOString(),
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
  for (const table of SEEDED_TABLES) {
    await client.exec(`DELETE FROM "${table}";`);
  }
});

describe("getPrincipalRoster", () => {
  test("returns a principal's owned instances (with session counts) and runs", async () => {
    await seedAgent("agt-1", "Myra");
    await seedAgent("agt-2", "Oat");
    await seedOwnedInstance({
      instanceId: "ins-1",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-1",
    });
    await seedOwnedInstance({
      instanceId: "ins-2",
      agentId: "agt-2",
      syntheticPrincipalId: "prn-syn-2",
      status: "ended",
    });
    await seedSession({ id: "ses-1", principalId: "prn-syn-1" });
    await seedSession({ id: "ses-2", principalId: "prn-syn-1" });
    await seedRun({ id: "run-1", kind: "last30days" });
    await seedRun({ id: "run-2", kind: "brief", status: "running" });

    const roster = await getPrincipalRoster({
      db,
      tenantId: TENANT,
      principalId: MEMBER,
    });

    // Sorted by agent name: Myra before Oat.
    expect(roster.instances.map((i) => i.name)).toEqual(["Myra", "Oat"]);
    const myra = roster.instances[0]!;
    expect(myra.instanceId).toBe("ins-1");
    expect(myra.principalId).toBe("prn-syn-1");
    expect(myra.status).toBe("running");
    expect(myra.sessionCount).toBe(2);
    expect(roster.instances[1]!.sessionCount).toBe(0);

    expect(new Set(roster.runs.map((r) => r.runId))).toEqual(
      new Set(["run-1", "run-2"]),
    );
    const running = roster.runs.find((r) => r.runId === "run-2")!;
    expect(running.kind).toBe("brief");
    expect(running.status).toBe("running");
  });

  test("does not leak another member's instances or runs, nor cross tenants", async () => {
    await seedAgent("agt-1", "Myra");
    // Owned by a DIFFERENT member.
    await seedOwnedInstance({
      instanceId: "ins-other",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-other",
      memberPrincipalId: OTHER_MEMBER,
    });
    // Same member id but a different tenant.
    await client.query(
      `insert into agent (id, tenant_id, creator_principal_id, name) values ('agt-x', $1, 'prn-creator', 'Alien')`,
      [OTHER_TENANT],
    );
    await seedOwnedInstance({
      instanceId: "ins-xtenant",
      agentId: "agt-x",
      syntheticPrincipalId: "prn-syn-xtenant",
      tenantId: OTHER_TENANT,
    });
    // Runs owned by another member / another tenant.
    await seedRun({ id: "run-other", principalId: OTHER_MEMBER });
    await seedRun({ id: "run-xtenant", tenantId: OTHER_TENANT });

    const roster = await getPrincipalRoster({
      db,
      tenantId: TENANT,
      principalId: MEMBER,
    });

    expect(roster.instances).toHaveLength(0);
    expect(roster.runs).toHaveLength(0);
  });

  test("soft-deleted runs are excluded", async () => {
    await seedRun({ id: "run-live" });
    await seedRun({ id: "run-gone" });
    await client.query(
      `update workflow_run_record set deleted_at = now() where id = 'run-gone'`,
    );

    const roster = await getPrincipalRoster({
      db,
      tenantId: TENANT,
      principalId: MEMBER,
    });

    expect(roster.runs.map((r) => r.runId)).toEqual(["run-live"]);
  });
});

describe("getTenantRoster", () => {
  test("lists every owned instance across members and recent runs across principals", async () => {
    await seedAgent("agt-1", "Myra");
    await seedAgent("agt-2", "Oat");
    // Two instances owned by two DIFFERENT members — both belong to the tenant.
    await seedOwnedInstance({
      instanceId: "ins-1",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-1",
      memberPrincipalId: MEMBER,
    });
    await seedOwnedInstance({
      instanceId: "ins-2",
      agentId: "agt-2",
      syntheticPrincipalId: "prn-syn-2",
      memberPrincipalId: OTHER_MEMBER,
      status: "ended",
    });
    await seedSession({ id: "ses-1", principalId: "prn-syn-1" });
    // Runs started by two different principals.
    await seedRun({ id: "run-mine", principalId: MEMBER });
    await seedRun({ id: "run-theirs", principalId: OTHER_MEMBER });

    const roster = await getTenantRoster({ db, tenantId: TENANT });

    expect(roster.instances.map((i) => i.name)).toEqual(["Myra", "Oat"]);
    expect(roster.instances[0]!.sessionCount).toBe(1);
    expect(new Set(roster.runs.map((r) => r.runId))).toEqual(
      new Set(["run-mine", "run-theirs"]),
    );
  });

  test("dedupes an instance shared by more than one member", async () => {
    await seedAgent("agt-1", "Shared");
    await seedOwnedInstance({
      instanceId: "ins-shared",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-shared",
      memberPrincipalId: MEMBER,
    });
    // A second member mapping to the SAME instance.
    await client.query(
      `insert into member_agent_instance (id, tenant_id, member_principal_id, template_key, agent_id, instance_id)
       values ('link-second', $1, $2, 'myra', 'agt-1', 'ins-shared')`,
      [TENANT, OTHER_MEMBER],
    );

    const roster = await getTenantRoster({ db, tenantId: TENANT });

    expect(roster.instances.map((i) => i.instanceId)).toEqual(["ins-shared"]);
  });

  test("orders runs most-recent first and respects the run limit", async () => {
    await seedRun({ id: "run-old", createdAt: "2024-01-01T00:00:00Z" });
    await seedRun({ id: "run-mid", createdAt: "2024-06-01T00:00:00Z" });
    await seedRun({ id: "run-new", createdAt: "2024-12-01T00:00:00Z" });

    const roster = await getTenantRoster({ db, tenantId: TENANT, runLimit: 2 });

    expect(roster.runs.map((r) => r.runId)).toEqual(["run-new", "run-mid"]);
  });

  test("does not cross tenants and excludes soft-deleted runs", async () => {
    await seedAgent("agt-1", "Mine");
    await seedOwnedInstance({
      instanceId: "ins-mine",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-mine",
    });
    await client.query(
      `insert into agent (id, tenant_id, creator_principal_id, name) values ('agt-x', $1, 'prn-creator', 'Alien')`,
      [OTHER_TENANT],
    );
    await seedOwnedInstance({
      instanceId: "ins-xtenant",
      agentId: "agt-x",
      syntheticPrincipalId: "prn-syn-xtenant",
      tenantId: OTHER_TENANT,
    });
    await seedRun({ id: "run-live" });
    await seedRun({ id: "run-gone" });
    await seedRun({ id: "run-xtenant", tenantId: OTHER_TENANT });
    await client.query(
      `update workflow_run_record set deleted_at = now() where id = 'run-gone'`,
    );

    const roster = await getTenantRoster({ db, tenantId: TENANT });

    expect(roster.instances.map((i) => i.instanceId)).toEqual(["ins-mine"]);
    expect(roster.runs.map((r) => r.runId)).toEqual(["run-live"]);
  });
});
