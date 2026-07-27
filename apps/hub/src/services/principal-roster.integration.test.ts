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
  templateKey?: string;
  label?: string | null;
  lastActivityAt?: string;
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
    `insert into member_agent_instance (id, tenant_id, member_principal_id, template_key, agent_id, instance_id, label, last_activity_at)
     values ('link-' || $1, $2, $3, $4, $5, $1, $6, coalesce($7::timestamptz, now()))`,
    [
      args.instanceId,
      args.tenantId ?? TENANT,
      args.memberPrincipalId ?? MEMBER,
      args.templateKey ?? "myra",
      args.agentId,
      args.label ?? null,
      args.lastActivityAt ?? null,
    ],
  );
}

// Agent instance with no member_agent_instance mapping (admin/dispatched).
async function seedUnmappedInstance(args: {
  instanceId: string;
  agentId: string;
  syntheticPrincipalId: string;
  tenantId?: string;
  status?: string;
  updatedAt?: string;
}): Promise<void> {
  await client.query(
    `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status, updated_at)
     values ($1, $2, $3, $4, $1 || '@wb.local', $5, coalesce($6::timestamptz, now()))`,
    [
      args.instanceId,
      args.agentId,
      args.tenantId ?? TENANT,
      args.syntheticPrincipalId,
      args.status ?? "running",
      args.updatedAt ?? null,
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
  originConversationId?: string | null;
}): Promise<void> {
  await client.query(
    `insert into workflow_run_record (id, kind, tenant_id, principal_id, status, created_at, updated_at, origin_conversation_id)
     values ($1, $2, $3, $4, $5, $6, now(), $7)`,
    [
      args.id,
      args.kind ?? "last30days",
      args.tenantId ?? TENANT,
      args.principalId ?? MEMBER,
      args.status ?? "completed",
      args.createdAt ?? new Date().toISOString(),
      args.originConversationId ?? null,
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

  // Agent principals are agent_instance.principal_id values — they own no
  // member_agent_instance rows and start no runs as themselves. The roster
  // must surface the instance itself and runs started FROM its conversation
  // (origin_conversation_id = member_agent_instance.id).
  test("agent principal returns its own instance and runs started from its conversation", async () => {
    await seedAgent("agt-1", "Myra");
    await seedOwnedInstance({
      instanceId: "ins-1",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-1",
      templateKey: "myra",
      label: "Acme renewal",
      lastActivityAt: "2026-04-01T00:00:00Z",
    });
    await seedSession({ id: "ses-1", principalId: "prn-syn-1" });
    await seedSession({ id: "ses-2", principalId: "prn-syn-1" });
    // Owned by the human member, but started from this agent's thread.
    // Two runs with fixed timestamps so order is most-recent first.
    await seedRun({
      id: "run-older",
      principalId: MEMBER,
      kind: "last30days",
      createdAt: "2026-01-01T00:00:00Z",
      originConversationId: "link-ins-1",
    });
    await seedRun({
      id: "run-newer",
      principalId: MEMBER,
      kind: "brief",
      createdAt: "2026-06-01T00:00:00Z",
      originConversationId: "link-ins-1",
    });
    // Started by the same member but not from this agent's conversation.
    await seedRun({
      id: "run-other-origin",
      principalId: MEMBER,
      kind: "last30days",
      originConversationId: "link-other",
    });

    const roster = await getPrincipalRoster({
      db,
      tenantId: TENANT,
      principalId: "prn-syn-1",
    });

    expect(roster.instances).toHaveLength(1);
    const inst = roster.instances[0]!;
    expect(inst.instanceId).toBe("ins-1");
    expect(inst.principalId).toBe("prn-syn-1");
    expect(inst.name).toBe("Myra");
    expect(inst.sessionCount).toBe(2);
    expect(inst.templateKey).toBe("myra");
    expect(inst.label).toBe("Acme renewal");
    expect(inst.lastActivityAt).toBe("2026-04-01T00:00:00.000Z");
    expect(inst.address).toBe("ins-1@wb.local");

    expect(roster.runs.map((r) => r.runId)).toEqual(["run-newer", "run-older"]);
    expect(roster.runs[0]!.kind).toBe("brief");
  });

  test("agent principal does not leak another agent's instance or conversation runs", async () => {
    await seedAgent("agt-1", "Myra");
    await seedOwnedInstance({
      instanceId: "ins-mine",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-mine",
    });
    await seedOwnedInstance({
      instanceId: "ins-theirs",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-theirs",
      memberPrincipalId: OTHER_MEMBER,
    });
    await seedRun({
      id: "run-theirs",
      principalId: OTHER_MEMBER,
      originConversationId: "link-ins-theirs",
    });

    const roster = await getPrincipalRoster({
      db,
      tenantId: TENANT,
      principalId: "prn-syn-mine",
    });

    expect(roster.instances.map((i) => i.instanceId)).toEqual(["ins-mine"]);
    expect(roster.runs).toHaveLength(0);
  });

  test("excludes an unmapped per-step workflow instance sharing the deployment's principal (CL-3158)", async () => {
    // Mirrors workflow-deploy.ts: writeStepInstanceRows and
    // writeDeploymentInstanceRow both stamp `principalId: creatorPrincipalId`
    // — the SAME value the mapped, user-facing supervisor instance carries —
    // onto an internal per-step `agent_instance` row that never gets a
    // member_agent_instance mapping. Viewing that shared principal's roster
    // must surface only the real (mapped) instance, never the phantom step
    // row alongside it.
    await seedAgent("agt-1", "Myra");
    await seedOwnedInstance({
      instanceId: "ins-supervisor",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-shared",
      templateKey: "myra",
    });
    await seedUnmappedInstance({
      instanceId: "ins_dep-abc123-draft",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-shared",
    });

    const roster = await getPrincipalRoster({
      db,
      tenantId: TENANT,
      principalId: "prn-syn-shared",
    });

    expect(roster.instances.map((i) => i.instanceId)).toEqual([
      "ins-supervisor",
    ]);
  });

  test("agent principal without a member mapping still surfaces the instance", async () => {
    await seedAgent("agt-admin", "Admin agent");
    await seedUnmappedInstance({
      instanceId: "ins-admin",
      agentId: "agt-admin",
      syntheticPrincipalId: "prn-syn-admin",
      updatedAt: "2026-05-15T12:00:00Z",
    });

    const roster = await getPrincipalRoster({
      db,
      tenantId: TENANT,
      principalId: "prn-syn-admin",
    });

    expect(roster.instances).toHaveLength(1);
    const inst = roster.instances[0]!;
    expect(inst.instanceId).toBe("ins-admin");
    expect(inst.principalId).toBe("prn-syn-admin");
    expect(inst.name).toBe("Admin agent");
    expect(inst.templateKey).toBe("unknown");
    expect(inst.label).toBeNull();
    expect(inst.lastActivityAt).toBe("2026-05-15T12:00:00.000Z");
    expect(inst.sessionCount).toBe(0);
    expect(roster.runs).toHaveLength(0);
  });
});

describe("getTenantRoster", () => {
  test("carries the instance's templateKey, label, lastActivityAt and address (CL-3770)", async () => {
    await seedAgent("agt-1", "Myra");
    await seedOwnedInstance({
      instanceId: "ins-chat",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-chat",
      templateKey: "myra",
      label: "Renewal terms for Acme",
      lastActivityAt: "2026-02-01T00:00:00Z",
    });
    await seedOwnedInstance({
      instanceId: "ins-triage",
      agentId: "agt-1",
      syntheticPrincipalId: "prn-syn-triage",
      templateKey: "myra-triage",
      label: "Triage: Q3 renewal follow-up",
      lastActivityAt: "2026-03-01T00:00:00Z",
    });

    const roster = await getTenantRoster({ db, tenantId: TENANT });

    const chat = roster.instances.find((i) => i.instanceId === "ins-chat")!;
    expect(chat.templateKey).toBe("myra");
    expect(chat.label).toBe("Renewal terms for Acme");
    expect(chat.lastActivityAt).toBe("2026-02-01T00:00:00.000Z");
    expect(chat.address).toBe("ins-chat@wb.local");

    const triage = roster.instances.find((i) => i.instanceId === "ins-triage")!;
    expect(triage.templateKey).toBe("myra-triage");
    expect(triage.label).toBe("Triage: Q3 renewal follow-up");
  });

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
