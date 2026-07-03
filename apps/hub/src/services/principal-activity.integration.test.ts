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
import {
  buildTimelineBranchQuery,
  timelineSources,
  type TimelineEntry,
} from "@workbench/timeline";

import { schema } from "../db";
import type { HubDb } from "../db";
import { getPrincipalActivityPage } from "./principal-activity";

// Real-Postgres drift guard for the timeline union (CL-2490). The
// @workbench/timeline registry references tables and columns by NAME (plain
// strings), so nothing at compile time ties a descriptor to the drizzle
// schema — a renamed column ships a runtime 500 with a green build. This
// suite pushes the REAL hub + intx drizzle schema into PGlite (in-process
// wasm Postgres) via drizzle-kit's pushSchema, then executes the generated
// union against those tables: any descriptor referencing a table or column
// that no longer exists fails here.
//
// FK enforcement is disabled for seeding (session_replication_role=replica)
// so each test plants only timeline-relevant rows, not the whole entity
// graph; NOT NULL and column-name checks remain fully enforced.

const TENANT = "tn-timeline";
const OTHER_TENANT = "tn-other";
const PRINCIPAL = "prn-target";
const OTHER_PRINCIPAL = "prn-other";

let client: PGlite;
let db: HubDb;

const SEEDED_TABLES = [
  "member_agent_instance",
  "agent_instance",
  "agent_session",
  "session_mail",
  "inference_turn",
  "analytics_event",
  "workflow_run_record",
  "artifact",
  "memory",
  "credential",
];

async function seedSession(args: {
  id: string;
  tenantId?: string;
  principalId?: string;
  createdAt: string;
}): Promise<void> {
  await client.query(
    `insert into agent_session (id, tenant_id, agent_id, principal_id, status, created_at, updated_at)
     values ($1, $2, 'agt-x', $3, 'active', $4, $4)`,
    [
      args.id,
      args.tenantId ?? TENANT,
      args.principalId ?? PRINCIPAL,
      args.createdAt,
    ],
  );
}

async function seedMail(args: {
  id: string;
  sessionId: string;
  tenantId?: string;
  createdAt: string;
}): Promise<void> {
  await client.query(
    `insert into session_mail (id, session_id, tenant_id, direction, status, raw, created_at)
     values ($1, $2, $3, 'inbound', 'delivered', ''::bytea, $4)`,
    [args.id, args.sessionId, args.tenantId ?? TENANT, args.createdAt],
  );
}

async function seedTurn(args: {
  id: string;
  sessionId: string;
  tenantId?: string;
  startedAt: string;
}): Promise<void> {
  await client.query(
    `insert into inference_turn (id, session_id, instance_id, tenant_id, model, status, started_at)
     values ($1, $2, 'ins-x', $3, 'deepseek-v4-flash', 'completed', $4)`,
    [args.id, args.sessionId, args.tenantId ?? TENANT, args.startedAt],
  );
}

async function seedToolCall(args: {
  id: string;
  tenantId?: string;
  principalId?: string;
  eventType?: string;
  occurredAt: string;
}): Promise<void> {
  await client.query(
    `insert into analytics_event (id, tenant_id, principal_id, event_key, event_type, tool_call_id, occurred_at)
     values ($1, $2, $3, $1, $4, 'toolu_1', $5)`,
    [
      args.id,
      args.tenantId ?? TENANT,
      args.principalId ?? PRINCIPAL,
      args.eventType ?? "tool_call",
      args.occurredAt,
    ],
  );
}

async function seedRunRecord(args: {
  id: string;
  tenantId?: string;
  principalId?: string;
  createdAt: string;
}): Promise<void> {
  await client.query(
    `insert into workflow_run_record (id, kind, tenant_id, principal_id, status, created_at, updated_at)
     values ($1, 'last30days', $2, $3, 'completed', $4, $4)`,
    [
      args.id,
      args.tenantId ?? TENANT,
      args.principalId ?? PRINCIPAL,
      args.createdAt,
    ],
  );
}

async function seedArtifact(args: {
  id: string;
  tenantId?: string;
  ownerPrincipalId?: string | null;
  principalId?: string | null;
  createdAt: string;
}): Promise<void> {
  await client.query(
    `insert into artifact (id, tenant_id, principal_id, owner_principal_id, kind, title, content, created_at, updated_at)
     values ($1, $2, $3, $4, 'doc', 'Artifact title', 'body', $5, $5)`,
    [
      args.id,
      args.tenantId ?? TENANT,
      args.principalId ?? null,
      args.ownerPrincipalId ?? null,
      args.createdAt,
    ],
  );
}

async function seedMemory(args: {
  id: string;
  tenantId?: string;
  ownerPrincipalId?: string;
  updatedAt: string;
}): Promise<void> {
  await client.query(
    `insert into memory (id, tenant_id, owner_principal_id, content, created_at, updated_at)
     values ($1, $2, $3, 'remember this', $4, $4)`,
    [
      args.id,
      args.tenantId ?? TENANT,
      args.ownerPrincipalId ?? PRINCIPAL,
      args.updatedAt,
    ],
  );
}

async function seedCredential(args: {
  id: string;
  tenantId?: string;
  principalId?: string | null;
  createdAt: string;
}): Promise<void> {
  await client.query(
    `insert into credential (id, tenant_id, principal_id, provider_id, name, type, secret, created_at, updated_at)
     values ($1, $2, $3, 'prv-x', 'My key', 'api_key', 'sealed', $4, $4)`,
    [
      args.id,
      args.tenantId ?? TENANT,
      args.principalId === undefined ? PRINCIPAL : args.principalId,
      args.createdAt,
    ],
  );
}

function page(args: { limit: number; cursor?: string }) {
  return getPrincipalActivityPage({
    db,
    tenantId: TENANT,
    principalId: PRINCIPAL,
    limit: args.limit,
    ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
  });
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

describe("descriptor drift guard — registry strings vs the real schema", () => {
  test.each(timelineSources.map((d) => [d.kind, d] as const))(
    "descriptor %s references only tables and columns that exist",
    async (_kind, descriptor) => {
      const query = buildTimelineBranchQuery(descriptor, {
        scope: { tenantId: TENANT, principalId: PRINCIPAL },
        limit: 1,
      });
      // Executes against the pushed drizzle schema: a renamed table or
      // column in either the schema or the registry throws here.
      await db.execute(query);
    },
  );
});

async function seedOwnedInstance(args: {
  instanceId: string;
  syntheticPrincipalId: string;
  memberPrincipalId: string;
  tenantId?: string;
}): Promise<void> {
  await client.query(
    `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status)
     values ($1, 'agt-x', $2, $3, $1 || '@wb.local', 'running')`,
    [args.instanceId, args.tenantId ?? TENANT, args.syntheticPrincipalId],
  );
  await client.query(
    `insert into member_agent_instance (id, tenant_id, member_principal_id, template_key, agent_id, instance_id)
     values ('link-' || $1, $2, $3, 'myra', 'agt-x', $1)`,
    [args.instanceId, args.tenantId ?? TENANT, args.memberPrincipalId],
  );
}

describe("getPrincipalActivityPage — union over real tables", () => {
  test("merges entries across sources in (ts desc, source_table, id) order and validates them", async () => {
    await seedSession({ id: "ses-1", createdAt: "2026-07-01T10:00:00Z" });
    await seedMail({
      id: "mail-1",
      sessionId: "ses-1",
      createdAt: "2026-07-01T10:01:00Z",
    });
    await seedTurn({
      id: "turn-1",
      sessionId: "ses-1",
      startedAt: "2026-07-01T10:02:00Z",
    });
    await seedToolCall({ id: "evt-1", occurredAt: "2026-07-01T10:03:00Z" });
    await seedRunRecord({ id: "run-1", createdAt: "2026-07-01T10:04:00Z" });
    await seedMemory({
      id: "3a0b8f60-0000-4000-8000-000000000001",
      updatedAt: "2026-07-01T10:05:00Z",
    });
    await seedCredential({ id: "crd-1", createdAt: "2026-07-01T10:06:00Z" });

    const result = await page({ limit: 20 });

    expect(result.entries.map((e) => e.kind)).toEqual([
      "credential",
      "memory",
      "workflow_run",
      "tool_call",
      "inference_turn",
      "message",
      "session",
    ]);
    expect(result.nextCursor).toBeNull();
    for (const entry of result.entries) {
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    }
    const bySummary = new Map(result.entries.map((e) => [e.kind, e.summary]));
    expect(bySummary.get("credential")).toBe("My key");
    expect(bySummary.get("memory")).toBe("remember this");
  });

  test("attributes exists-scoped sources (mail, inference) through the owning session and honors anyColumn artifact scope", async () => {
    await seedSession({ id: "ses-own", createdAt: "2026-07-01T09:00:00Z" });
    await seedSession({
      id: "ses-foreign",
      principalId: OTHER_PRINCIPAL,
      createdAt: "2026-07-01T09:00:01Z",
    });
    await seedMail({
      id: "mail-own",
      sessionId: "ses-own",
      createdAt: "2026-07-01T09:01:00Z",
    });
    await seedMail({
      id: "mail-foreign",
      sessionId: "ses-foreign",
      createdAt: "2026-07-01T09:01:01Z",
    });
    await seedTurn({
      id: "turn-foreign",
      sessionId: "ses-foreign",
      startedAt: "2026-07-01T09:02:00Z",
    });
    await seedArtifact({
      id: "3a0b8f60-0000-4000-8000-00000000a001",
      ownerPrincipalId: PRINCIPAL,
      createdAt: "2026-07-01T09:03:00Z",
    });
    await seedArtifact({
      id: "3a0b8f60-0000-4000-8000-00000000a002",
      principalId: OTHER_PRINCIPAL,
      createdAt: "2026-07-01T09:03:01Z",
    });

    const result = await page({ limit: 20 });
    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain("mail-own");
    expect(ids).toContain("3a0b8f60-0000-4000-8000-00000000a001");
    expect(ids).not.toContain("mail-foreign");
    expect(ids).not.toContain("turn-foreign");
    expect(ids).not.toContain("3a0b8f60-0000-4000-8000-00000000a002");
  });

  test("never leaks rows across tenants or principals", async () => {
    await seedRunRecord({ id: "run-mine", createdAt: "2026-07-01T08:00:00Z" });
    await seedRunRecord({
      id: "run-other-tenant",
      tenantId: OTHER_TENANT,
      createdAt: "2026-07-01T08:00:01Z",
    });
    await seedRunRecord({
      id: "run-other-principal",
      principalId: OTHER_PRINCIPAL,
      createdAt: "2026-07-01T08:00:02Z",
    });
    await seedCredential({
      id: "crd-other-tenant",
      tenantId: OTHER_TENANT,
      createdAt: "2026-07-01T08:00:03Z",
    });
    // Tenant-owned credential: principal_id is null and must not match.
    await seedCredential({
      id: "crd-tenant-owned",
      principalId: null,
      createdAt: "2026-07-01T08:00:04Z",
    });

    const result = await page({ limit: 20 });
    expect(result.entries.map((e) => e.id)).toEqual(["run-mine"]);
  });

  test("filterSql excludes non-tool analytics events and soft-deleted runs", async () => {
    await seedToolCall({ id: "evt-tool", occurredAt: "2026-07-01T07:00:00Z" });
    await seedToolCall({
      id: "evt-turn",
      eventType: "turn",
      occurredAt: "2026-07-01T07:00:01Z",
    });
    await seedRunRecord({ id: "run-live", createdAt: "2026-07-01T07:01:00Z" });
    await client.query(
      `update workflow_run_record set deleted_at = now() where id = $1`,
      ["run-live"],
    );

    const result = await page({ limit: 20 });
    expect(result.entries.map((e) => e.id)).toEqual(["evt-tool"]);
  });

  test("keyset pagination drops and duplicates nothing across a same-timestamp page boundary", async () => {
    const tied = "2026-07-01T06:00:00Z";
    await seedSession({ id: "ses-tie", createdAt: tied });
    await seedRunRecord({ id: "run-tie", createdAt: tied });
    await seedMemory({
      id: "3a0b8f60-0000-4000-8000-0000000000b1",
      updatedAt: tied,
    });
    await seedCredential({ id: "crd-tie", createdAt: tied });
    await seedSession({ id: "ses-late", createdAt: "2026-07-01T06:30:00Z" });
    await seedMail({
      id: "mail-early",
      sessionId: "ses-tie",
      createdAt: "2026-07-01T05:30:00Z",
    });

    const full = await page({ limit: 20 });
    expect(full.entries).toHaveLength(6);

    const paged: TimelineEntry[] = [];
    let cursor: string | undefined;
    let rounds = 0;
    for (;;) {
      const result = await page({
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      paged.push(...result.entries);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
      rounds += 1;
      if (rounds > 10) throw new Error("pagination did not terminate");
    }

    expect(paged.map((e) => `${e.sourceTable}:${e.id}`)).toEqual(
      full.entries.map((e) => `${e.sourceTable}:${e.id}`),
    );
  });

  test("returns a cursor only when the page is full", async () => {
    await seedSession({ id: "ses-a", createdAt: "2026-07-01T04:00:00Z" });
    await seedSession({ id: "ses-b", createdAt: "2026-07-01T04:01:00Z" });

    const fullPage = await page({ limit: 2 });
    expect(fullPage.nextCursor).not.toBeNull();

    const shortPage = await page({ limit: 3 });
    expect(shortPage.nextCursor).toBeNull();
  });

  test("rejects a malformed cursor token", async () => {
    await expect(page({ limit: 5, cursor: "not-a-cursor" })).rejects.toThrow(
      /invalid timeline cursor/i,
    );
  });
});

describe("instance-principal attribution through member_agent_instance", () => {
  test("a user's timeline includes activity recorded under their owned instance's synthetic principal", async () => {
    const SYNTH = "prn-synth-myra";
    await seedOwnedInstance({
      instanceId: "ins-myra-u",
      syntheticPrincipalId: SYNTH,
      memberPrincipalId: PRINCIPAL,
    });
    await seedSession({
      id: "ses-synth",
      principalId: SYNTH,
      createdAt: "2026-07-01T11:00:00Z",
    });
    await seedMail({
      id: "mail-synth",
      sessionId: "ses-synth",
      createdAt: "2026-07-01T11:01:00Z",
    });
    await seedTurn({
      id: "turn-synth",
      sessionId: "ses-synth",
      startedAt: "2026-07-01T11:02:00Z",
    });
    await seedToolCall({
      id: "evt-synth",
      principalId: SYNTH,
      occurredAt: "2026-07-01T11:03:00Z",
    });

    const mine = await page({ limit: 20 });
    const mineIds = mine.entries.map((e) => e.id);
    expect(mineIds).toContain("ses-synth");
    expect(mineIds).toContain("mail-synth");
    expect(mineIds).toContain("turn-synth");
    expect(mineIds).toContain("evt-synth");

    const theirs = await getPrincipalActivityPage({
      db,
      tenantId: TENANT,
      principalId: OTHER_PRINCIPAL,
      limit: 20,
    });
    expect(theirs.entries).toHaveLength(0);
  });

  test("an instance link in another tenant does not pull its synthetic principal into this tenant's timeline", async () => {
    const SYNTH = "prn-synth-foreign";
    await seedOwnedInstance({
      instanceId: "ins-foreign",
      syntheticPrincipalId: SYNTH,
      memberPrincipalId: PRINCIPAL,
      tenantId: OTHER_TENANT,
    });
    await seedSession({
      id: "ses-synth-foreign",
      principalId: SYNTH,
      createdAt: "2026-07-01T11:10:00Z",
    });

    const mine = await page({ limit: 20 });
    expect(mine.entries.map((e) => e.id)).not.toContain("ses-synth-foreign");
  });
});
