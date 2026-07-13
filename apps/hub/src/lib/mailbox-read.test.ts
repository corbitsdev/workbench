import { describe, expect, it, mock } from "bun:test";

const resolveSenderDisplayNamesMock = mock(
  async (
    _db: unknown,
    _tenantId: string,
    _fromHeaders: string[],
  ): Promise<Map<string, string>> => new Map(),
);

mock.module("./mail-sender-display", () => ({
  extractSenderMailboxAddress: (fromHeader: string) => fromHeader.trim(),
  attachFromDisplay: (
    fromHeader: string,
    displays: Map<string, string>,
  ): string | undefined => {
    const display = displays.get(fromHeader.trim());
    return display === undefined ? undefined : display;
  },
  resolveSenderDisplayNames: resolveSenderDisplayNamesMock,
}));

import { generateKeyPair, createEd25519Crypto } from "@intx/crypto";
import {
  assembleMessage,
  assembleSignedContent,
  createDetachedSignatureFromProvider,
  generateMessageId,
  type MessageHeaders,
} from "@intx/mime";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { HubDb } from "../db";
import {
  getMailboxMessage,
  listUserMailbox,
  markMailboxMessageRead,
} from "./mailbox-read";

function signedMorningBriefHeaders(): MessageHeaders {
  return {
    from: "ins_ses_dep@tenant.example",
    to: ["usr_alice@tenant.example"],
    cc: undefined,
    date: new Date("2026-07-10T07:00:00Z"),
    messageId: generateMessageId("ins_ses_dep@tenant.example"),
    subject: "Your morning brief",
    inReplyTo: undefined,
    references: undefined,
    mimeVersion: "1.0",
    interchangeType: "conversation.message",
    interchangeCorrelationId: undefined,
    interchangeTenantId: undefined,
    interchangeAgentId: undefined,
    interchangeSessionId: undefined,
    interchangeOfferingId: undefined,
    interchangeSchemaVersion: undefined,
    traceparent: undefined,
    tracestate: undefined,
  };
}

async function assembleSignedConversationFrame(text: string): Promise<Buffer> {
  const kp = await generateKeyPair();
  const crypto = createEd25519Crypto(kp);
  const content = assembleSignedContent({ kind: "conversation", text });
  const sig = await createDetachedSignatureFromProvider(content, crypto);
  const raw = assembleMessage(signedMorningBriefHeaders(), content, sig);
  return Buffer.from(raw);
}

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
    const { items: messages } = await listUserMailbox(db, {
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
      date: "2026-07-10T07:00:00.000Z",
      messageId: "<m1@tenant.example>",
      snippet: "Your brief is ready.",
      read: false,
    });
    expect(messages[1]?.read).toBe(true);
  });

  it("attaches fromDisplay when sender labels resolve", async () => {
    resolveSenderDisplayNamesMock.mockImplementationOnce(async () =>
      new Map([["ins_dep-heartbeat@tenant.example", "Heartbeat"]]),
    );
    const { db } = makeListDb([makeRow()]);
    const { items: messages } = await listUserMailbox(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      limit: 50,
    });
    expect(messages[0]?.fromDisplay).toBe("Heartbeat");
  });

  it("decodes PGP/MIME signed conversation frames to plain text for snippets", async () => {
    const briefText = "## Morning brief\n\nGranola notes here.";
    const raw = await assembleSignedConversationFrame(briefText);
    const { db } = makeListDb([
      makeRow({ raw, subject: "Your morning brief" }),
    ]);
    const { items: messages } = await listUserMailbox(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      limit: 50,
    });

    expect(messages[0]?.snippet).toBe(briefText.slice(0, 160));
    expect(messages[0]?.snippet).not.toContain("multipart/mixed");
    expect(messages[0]?.snippet).not.toContain("=_Part_");
  });

  it("scopes the query to the caller's tenant, principal, and inbound direction", async () => {
    const { db, findMany } = makeListDb([]);
    await listUserMailbox(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      limit: 25,
    });

    const arg = findMany.mock.calls[0]?.[0];
    expect(arg?.limit).toBe(26);
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
    const { items: messages } = await listUserMailbox(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      limit: 50,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      from: "ins_dep-heartbeat@tenant.example",
      to: ["usr_alice@tenant.example"],
      subject: "Morning brief",
      date: "2026-07-10T07:00:01.000Z",
      read: false,
    });
  });

  it("does not split a quoted display name containing a comma in the To header", async () => {
    const { db } = makeListDb([
      makeRow({
        raw: Buffer.from(
          "From: ins_dep-heartbeat@tenant.example\r\n" +
            'To: "Doe, Jane" <usr_alice@tenant.example>, usr_bob@tenant.example\r\n' +
            "Subject: Morning brief\r\n" +
            "\r\n" +
            "Your brief is ready.\r\n",
        ),
      }),
    ]);
    const page = await listUserMailbox(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      limit: 50,
    });

    expect(page.items[0]?.to).toEqual([
      '"Doe, Jane" <usr_alice@tenant.example>',
      "usr_bob@tenant.example",
    ]);
  });

  it("falls back to created_at when the Date header is unparseable", async () => {
    const { db } = makeListDb([
      makeRow({
        raw: Buffer.from(
          "From: ins_dep-heartbeat@tenant.example\r\n" +
            "Date: not a date\r\n" +
            "\r\n" +
            "Body.\r\n",
        ),
      }),
    ]);
    const { items: messages } = await listUserMailbox(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      limit: 50,
    });
    expect(messages[0]?.date).toBe("2026-07-10T07:00:01.000Z");
  });
});

describe("getMailboxMessage", () => {
  function makeDetailDb(row: unknown) {
    const findFirst = mock(async (_args: { where: unknown }) => row);
    const db = {
      query: { principalMailbox: { findFirst } },
    } as unknown as HubDb;
    return { db, findFirst };
  }

  it("returns the full body and an ISO date", async () => {
    const { db } = makeDetailDb(makeRow());
    const message = await getMailboxMessage(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      id: "5e0f8c9a-0000-4000-8000-000000000001",
    });

    expect(message).toEqual({
      id: "5e0f8c9a-0000-4000-8000-000000000001",
      from: "ins_dep-heartbeat@tenant.example",
      to: ["usr_alice@tenant.example", "usr_bob@tenant.example"],
      subject: "Morning brief",
      date: "2026-07-10T07:00:00.000Z",
      messageId: "<m1@tenant.example>",
      snippet: "Your brief is ready.",
      read: false,
      body: "Your brief is ready.",
    });
  });

  it("returns full brief text from a signed conversation frame", async () => {
    const briefText = "## Morning brief\n\nGranola notes here.";
    const raw = await assembleSignedConversationFrame(briefText);
    const { db } = makeDetailDb(
      makeRow({ raw, subject: "Your morning brief" }),
    );
    const message = await getMailboxMessage(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      id: "5e0f8c9a-0000-4000-8000-000000000001",
    });

    expect(message?.body).toBe(briefText);
    expect(message?.body).not.toContain("application/pgp-signature");
  });

  it("degrades to an empty body when the stored frame is malformed", async () => {
    const { db } = makeDetailDb(makeRow({ raw: Buffer.from("not a frame") }));
    const message = await getMailboxMessage(db, {
      tenantId: "ten-1",
      principalId: "pri-alice",
      id: "5e0f8c9a-0000-4000-8000-000000000001",
    });

    expect(message).toMatchObject({
      subject: "Morning brief",
      date: "2026-07-10T07:00:01.000Z",
      body: "",
    });
  });

  it("scopes the lookup to the caller's tenant, principal, and inbound direction", async () => {
    const { db, findFirst } = makeDetailDb(undefined);
    const message = await getMailboxMessage(db, {
      tenantId: "ten-1",
      principalId: "pri-bob",
      id: "5e0f8c9a-0000-4000-8000-000000000001",
    });

    expect(message).toBeNull();
    const { sql, params } = renderWhere(findFirst.mock.calls[0]?.[0]?.where);
    expect(sql).toContain("tenant_id");
    expect(sql).toContain("principal_id");
    expect(sql).toContain("direction");
    expect(params).toContain("ten-1");
    expect(params).toContain("pri-bob");
    expect(params).toContain("inbound");
    expect(params).toContain("5e0f8c9a-0000-4000-8000-000000000001");
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
