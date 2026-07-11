import { describe, expect, it, mock } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { HubDb } from "../db";
import { listUserMailbox, markMailboxMessageRead } from "./mailbox-read";

const RAW = Buffer.from(
  "From: ins_dep-heartbeat@tenant.example\r\n" +
    "To: usr_alice@tenant.example, usr_bob@tenant.example\r\n" +
    "Subject: Morning brief\r\n" +
    "Date: Fri, 10 Jul 2026 07:00:00 +0000\r\n" +
    "Message-ID: <m1@tenant.example>\r\n" +
    "\r\n" +
    "Your brief is ready.\r\n",
);

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "5e0f8c9a-0000-4000-8000-000000000001",
    tenantId: "ten-1",
    principalId: "pri-alice",
    address: "usr_alice@tenant.example",
    direction: "inbound" as const,
    raw: RAW,
    subject: "Morning brief",
    fromAddress: "ins_dep-heartbeat@tenant.example",
    createdAt: new Date("2026-07-10T07:00:01.000Z"),
    readAt: null,
    ...overrides,
  };
}

function renderWhere(where: unknown): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(where as SQL);
  return { sql: query.sql, params: query.params };
}

function makeListDb(rows: unknown[]) {
  const findMany = mock(
    async (_args: { where: unknown; limit: number }) => rows,
  );
  const db = {
    query: { principalMailbox: { findMany } },
  } as unknown as HubDb;
  return { db, findMany };
}

describe("listUserMailbox", () => {
  it("decodes stored frames into mailbox messages via the real MIME parser", async () => {
    const { db } = makeListDb([
      makeRow(),
      makeRow({
        id: "5e0f8c9a-0000-4000-8000-000000000002",
        readAt: new Date("2026-07-10T08:00:00.000Z"),
      }),
    ]);
    const messages = await listUserMailbox(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      limit: 50,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      id: "5e0f8c9a-0000-4000-8000-000000000001",
      from: "ins_dep-heartbeat@tenant.example",
      to: ["usr_alice@tenant.example", "usr_bob@tenant.example"],
      subject: "Morning brief",
      date: "Fri, 10 Jul 2026 07:00:00 +0000",
      messageId: "<m1@tenant.example>",
      snippet: "Your brief is ready.",
      read: false,
    });
    expect(messages[1]?.read).toBe(true);
  });

  it("scopes the query to the caller's tenant, principal, and inbound direction", async () => {
    const { db, findMany } = makeListDb([]);
    await listUserMailbox(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      limit: 25,
    });

    const arg = findMany.mock.calls[0]?.[0];
    expect(arg?.limit).toBe(25);
    const { sql, params } = renderWhere(arg?.where);
    expect(sql).toContain("tenant_id");
    expect(sql).toContain("principal_id");
    expect(sql).toContain("direction");
    expect(params).toContain("ten-1");
    expect(params).toContain("pri-alice");
    expect(params).toContain("inbound");
  });

  it("degrades to cached headers when the stored frame is malformed", async () => {
    const { db } = makeListDb([
      makeRow({ raw: Buffer.from("not a mime frame") }),
    ]);
    const messages = await listUserMailbox(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      limit: 50,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      from: "ins_dep-heartbeat@tenant.example",
      to: ["usr_alice@tenant.example"],
      subject: "Morning brief",
      read: false,
    });
  });
});

describe("markMailboxMessageRead", () => {
  function makeUpdateDb(returned: { id: string }[]) {
    const captured: { where?: unknown } = {};
    const returning = mock(async () => returned);
    const where = mock((condition: unknown) => {
      captured.where = condition;
      return { returning };
    });
    const set = mock(() => ({ where }));
    const db = { update: mock(() => ({ set })) } as unknown as HubDb;
    return { db, captured };
  }

  it("stamps read_at scoped to the caller's principal and returns true", async () => {
    const { db, captured } = makeUpdateDb([
      { id: "5e0f8c9a-0000-4000-8000-000000000001" },
    ]);
    const marked = await markMailboxMessageRead(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      id: "5e0f8c9a-0000-4000-8000-000000000001",
    });

    expect(marked).toBe(true);
    const { sql, params } = renderWhere(captured.where);
    expect(sql).toContain("tenant_id");
    expect(sql).toContain("principal_id");
    expect(params).toContain("ten-1");
    expect(params).toContain("pri-alice");
    expect(params).toContain("5e0f8c9a-0000-4000-8000-000000000001");
  });

  it("returns false when no row matches the caller's scope", async () => {
    const { db } = makeUpdateDb([]);
    const marked = await markMailboxMessageRead(db, {
      tenantId: "ten-1",
      principalId: "pri-bob",
      id: "5e0f8c9a-0000-4000-8000-000000000001",
    });
    expect(marked).toBe(false);
  });
});
