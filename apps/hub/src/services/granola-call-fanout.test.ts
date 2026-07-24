import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";

// The Granola-enabled capability gate is mocked at its module boundary; the
// fan-out's matching, filtering, mail composition, and per-(call,recipient)
// dedupe run against real Postgres.
let enabledPrincipals = new Set<string>();
mock.module("../lib/capability-grants", () => ({
  isMemberSelfServiceCapabilityActive: async (
    _grantStore: unknown,
    _db: unknown,
    _tenantId: string,
    principalId: string,
  ) => enabledPrincipals.has(principalId),
}));

const { createGranolaCallFanout, matchParticipantsToMembers } = await import(
  "./granola-call-fanout"
);
import { schema } from "../db";
import type { HubDb } from "../db";
import type { CallAnalysis } from "@workbench/shared";

const ROOT = "ten-root";
const DOMAIN = "corbits.io";

let client: PGlite;
let db: HubDb;

const analysis: CallAnalysis = {
  summary: "s",
  painPoints: [],
  decisions: [],
  actionItems: [
    { description: "Own the follow-up", assignee: "alice@corbits.io" },
  ],
  tasks: [{ description: "Ping bob", assignee: "Bob Jones" }],
  peopleMentioned: [],
};

async function seedMember(refId: string, name: string, email: string) {
  const principalId = `prn-${refId}`;
  await db.insert(schema.user).values({ id: refId, name, email });
  await db.insert(schema.principal).values({
    id: principalId,
    tenantId: ROOT,
    kind: "user",
    refId,
    status: "active",
  });
  await db.insert(schema.memberAgentInstance).values({
    id: `mai-${refId}`,
    tenantId: ROOT,
    memberPrincipalId: principalId,
    templateKey: "myra",
    agentId: "agt",
    instanceId: `ins-${refId}`,
  });
  return principalId;
}

async function mailRows() {
  return client.query<{
    principal_id: string;
    subject: string;
    message_key: string;
  }>(
    `select principal_id, subject, message_key from principal_mailbox order by message_key`,
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
  await client.exec(
    `DELETE FROM principal_mailbox; DELETE FROM member_agent_instance; DELETE FROM principal; DELETE FROM "user";`,
  );
  enabledPrincipals = new Set<string>();
});

describe("matchParticipantsToMembers", () => {
  const members = [
    {
      principalId: "p1",
      refId: "u1",
      name: "Alice Smith",
      email: "alice@corbits.io",
    },
    {
      principalId: "p2",
      refId: "u2",
      name: "Bob Jones",
      email: "bob@corbits.io",
    },
    {
      principalId: "p3",
      refId: "u3",
      name: "Bob Jones",
      email: "bob2@corbits.io",
    },
  ];

  test("matches by email case-insensitively", () => {
    const { matched, unmatched } = matchParticipantsToMembers(
      ["ALICE@corbits.io"],
      members,
    );
    expect(matched.map((m) => m.principalId)).toEqual(["p1"]);
    expect(unmatched).toEqual([]);
  });

  test("an unknown email is unmatched, never guessed", () => {
    const { matched, unmatched } = matchParticipantsToMembers(
      ["stranger@acme.com"],
      members,
    );
    expect(matched).toEqual([]);
    expect(unmatched).toEqual(["stranger@acme.com"]);
  });

  test("an ambiguous name is skipped (two Bob Joneses)", () => {
    const { matched, unmatched } = matchParticipantsToMembers(
      ["Bob Jones"],
      members,
    );
    expect(matched).toEqual([]);
    expect(unmatched).toEqual(["Bob Jones"]);
  });

  test("an unambiguous name matches", () => {
    const { matched } = matchParticipantsToMembers(["Alice Smith"], members);
    expect(matched.map((m) => m.principalId)).toEqual(["p1"]);
  });
});

describe("granola call fan-out", () => {
  test("mails only Granola-enabled matched members, with their own tasks", async () => {
    const aliceId = await seedMember("u1", "Alice Smith", "alice@corbits.io");
    const bobId = await seedMember("u2", "Bob Jones", "bob@corbits.io");
    enabledPrincipals = new Set([aliceId]); // Bob is on the call but not enabled

    const fanout = createGranolaCallFanout({
      db,
      grantStore: {} as never,
      rootTenantId: ROOT,
      rootTenantDomain: DOMAIN,
    });

    const result = await fanout.fanOut({
      tenantId: ROOT,
      note: {
        id: "n1",
        title: "Sync",
        participants: ["alice@corbits.io", "bob@corbits.io"],
      },
      classification: "internal",
      analysis,
      artifactId: "art-1",
    });

    expect(result.delivered).toBe(1);
    const rows = (await mailRows()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.principal_id).toBe(aliceId);
    expect(rows[0]?.message_key).toBe(`granola-call:n1:${aliceId}`);
    expect(bobId).toBeDefined();
  });

  test("dedupes one mail per (call, recipient) across repeated fan-outs", async () => {
    const aliceId = await seedMember("u1", "Alice Smith", "alice@corbits.io");
    enabledPrincipals = new Set([aliceId]);
    const fanout = createGranolaCallFanout({
      db,
      grantStore: {} as never,
      rootTenantId: ROOT,
      rootTenantDomain: DOMAIN,
    });
    const input = {
      tenantId: ROOT,
      note: { id: "n2", title: "Sync", participants: ["alice@corbits.io"] },
      classification: "internal" as const,
      analysis,
      artifactId: "art-2",
    };
    const first = await fanout.fanOut(input);
    const second = await fanout.fanOut(input);
    expect(first.delivered).toBe(1);
    expect(second.delivered).toBe(0); // deduped by messageKey
    expect((await mailRows()).rows).toHaveLength(1);
  });
});
