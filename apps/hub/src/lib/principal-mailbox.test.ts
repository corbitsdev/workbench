import { describe, expect, it, mock } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { HubDb } from "../db";
import { createPrincipalMailboxPersist } from "./principal-mailbox";

// A real RFC 2822 frame: the seam parses it with the real @intx/mime
// parser — only the DB and the upstream lookup are stubbed.
const RAW = new TextEncoder().encode(
  "From: ins_dep-heartbeat@tenant.example\r\n" +
    "To: usr_alice@tenant.example\r\n" +
    "Subject: Morning brief\r\n" +
    "Date: Fri, 10 Jul 2026 07:00:00 +0000\r\n" +
    "\r\n" +
    "Your brief is ready.\r\n",
);

const SENDER = {
  id: "ins_dep-heartbeat",
  tenantId: "ten-1",
  address: "ins_dep-heartbeat@tenant.example",
};

function renderWhere(where: unknown): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(where as SQL);
  return { sql: query.sql, params: query.params };
}

function makeDb(opts: {
  sender: typeof SENDER | undefined;
  tenantDomain?: string | null;
  memberPrincipal?: { id: string } | undefined;
  insertThrows?: boolean;
}) {
  const inserted: Record<string, unknown>[][] = [];
  const values = mock((rows: Record<string, unknown>[]) => {
    if (opts.insertThrows) {
      return {
        returning: () =>
          Promise.reject(new Error("principal_mailbox insert failed")),
      };
    }
    inserted.push(rows);
    return {
      returning: () =>
        Promise.resolve(rows.map((_, index) => ({ id: `pm-${index}` }))),
    };
  });
  const principalFindFirst = mock(
    async (_args: { where: unknown }) => opts.memberPrincipal,
  );
  const db = {
    query: {
      agentInstance: { findFirst: mock(async () => opts.sender) },
      tenant: {
        findFirst: mock(async () =>
          opts.tenantDomain === undefined
            ? undefined
            : { id: "ten-1", domain: opts.tenantDomain },
        ),
      },
      principal: { findFirst: principalFindFirst },
    },
    insert: mock(() => ({ values })),
  } as unknown as HubDb;
  return { db, inserted, principalFindFirst };
}

function makeUpstream() {
  const calls: unknown[] = [];
  const rows = [
    {
      id: "sm-1",
      direction: "outbound" as const,
      instanceId: SENDER.id,
      address: SENDER.address,
      createdAt: new Date(),
    },
  ];
  const upstream = mock(async (args: unknown) => {
    calls.push(args);
    return rows;
  });
  return { upstream, calls, rows };
}

describe("createPrincipalMailboxPersist", () => {
  it("writes an inbound principal_mailbox row for a usr_ recipient and delegates upstream", async () => {
    const { db, inserted } = makeDb({
      sender: SENDER,
      tenantDomain: "tenant.example",
      memberPrincipal: { id: "pri-alice" },
    });
    const { upstream, calls, rows } = makeUpstream();
    const persist = createPrincipalMailboxPersist(db, upstream);

    const result = await persist({
      senderAddress: SENDER.address,
      recipients: ["usr_alice@tenant.example"],
      raw: RAW,
    });

    expect(result).toEqual(rows);
    expect(calls).toEqual([
      {
        senderAddress: SENDER.address,
        recipients: ["usr_alice@tenant.example"],
        raw: RAW,
      },
    ]);
    expect(inserted).toHaveLength(1);
    const row = inserted[0]?.[0];
    expect(row).toMatchObject({
      tenantId: "ten-1",
      principalId: "pri-alice",
      address: "usr_alice@tenant.example",
      direction: "inbound",
      subject: "Morning brief",
      fromAddress: "ins_dep-heartbeat@tenant.example",
    });
    // The stored bytes are the frame verbatim — raw stays authoritative.
    expect(new Uint8Array(row?.raw as Uint8Array)).toEqual(RAW);
  });

  it("resolves the recipient principal by refId, user kind, and the sender's tenant", async () => {
    const { db, principalFindFirst } = makeDb({
      sender: SENDER,
      tenantDomain: "tenant.example",
      memberPrincipal: { id: "pri-alice" },
    });
    const { upstream } = makeUpstream();
    const persist = createPrincipalMailboxPersist(db, upstream);

    await persist({
      senderAddress: SENDER.address,
      recipients: ["usr_alice@tenant.example"],
      raw: RAW,
    });

    const arg = principalFindFirst.mock.calls[0]?.[0];
    const { sql, params } = renderWhere(arg?.where);
    expect(sql).toContain("tenant_id");
    expect(sql).toContain("kind");
    expect(sql).toContain("ref_id");
    expect(params).toContain("ten-1");
    expect(params).toContain("user");
    expect(params).toContain("usr_alice");
  });

  it("skips only the mailbox write for an unauthorized sender and still delegates upstream", async () => {
    const { db, inserted } = makeDb({
      sender: undefined,
      tenantDomain: "tenant.example",
      memberPrincipal: { id: "pri-alice" },
    });
    const { upstream, calls, rows } = makeUpstream();
    const persist = createPrincipalMailboxPersist(db, upstream);

    const result = await persist({
      senderAddress: "usr_mallory@tenant.example",
      recipients: ["usr_alice@tenant.example"],
      raw: RAW,
    });

    expect(result).toEqual(rows);
    expect(calls).toHaveLength(1);
    expect(inserted).toEqual([]);
  });

  it("still writes the mailbox row and propagates the rejection when upstream throws", async () => {
    const { db, inserted } = makeDb({
      sender: SENDER,
      tenantDomain: "tenant.example",
      memberPrincipal: { id: "pri-alice" },
    });
    const upstream = mock(async () => {
      throw new Error(
        'Instance ins_dep-heartbeat has no session for address "ins_dep-heartbeat@tenant.example"',
      );
    });
    const persist = createPrincipalMailboxPersist(db, upstream);

    await expect(
      persist({
        senderAddress: SENDER.address,
        recipients: ["usr_alice@tenant.example"],
        raw: RAW,
      }),
    ).rejects.toThrow("has no session");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.[0]).toMatchObject({
      principalId: "pri-alice",
      direction: "inbound",
    });
  });

  it("returns the upstream result when the mailbox insert itself fails", async () => {
    const { db, inserted } = makeDb({
      sender: SENDER,
      tenantDomain: "tenant.example",
      memberPrincipal: { id: "pri-alice" },
      insertThrows: true,
    });
    const { upstream, rows } = makeUpstream();
    const persist = createPrincipalMailboxPersist(db, upstream);

    const result = await persist({
      senderAddress: SENDER.address,
      recipients: ["usr_alice@tenant.example"],
      raw: RAW,
    });

    expect(result).toEqual(rows);
    expect(inserted).toEqual([]);
  });

  it("writes no mailbox row for agent (ins_) recipients but still delegates", async () => {
    const { db, inserted } = makeDb({
      sender: SENDER,
      tenantDomain: "tenant.example",
      memberPrincipal: { id: "pri-alice" },
    });
    const { upstream, calls } = makeUpstream();
    const persist = createPrincipalMailboxPersist(db, upstream);

    await persist({
      senderAddress: SENDER.address,
      recipients: ["ins_other@tenant.example"],
      raw: RAW,
    });

    expect(inserted).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("writes no mailbox row when the recipient domain is not the sender tenant's domain", async () => {
    const { db, inserted } = makeDb({
      sender: SENDER,
      tenantDomain: "tenant.example",
      memberPrincipal: { id: "pri-alice" },
    });
    const { upstream } = makeUpstream();
    const persist = createPrincipalMailboxPersist(db, upstream);

    await persist({
      senderAddress: SENDER.address,
      recipients: ["usr_alice@other.example"],
      raw: RAW,
    });

    expect(inserted).toEqual([]);
  });

  it("writes no mailbox row when no member principal matches the refId", async () => {
    const { db, inserted } = makeDb({
      sender: SENDER,
      tenantDomain: "tenant.example",
      memberPrincipal: undefined,
    });
    const { upstream } = makeUpstream();
    const persist = createPrincipalMailboxPersist(db, upstream);

    await persist({
      senderAddress: SENDER.address,
      recipients: ["usr_ghost@tenant.example"],
      raw: RAW,
    });

    expect(inserted).toEqual([]);
  });

  it("still persists a frame whose header section is malformed, without cached headers", async () => {
    const { db, inserted } = makeDb({
      sender: SENDER,
      tenantDomain: "tenant.example",
      memberPrincipal: { id: "pri-alice" },
    });
    const { upstream } = makeUpstream();
    const persist = createPrincipalMailboxPersist(db, upstream);

    const malformed = new TextEncoder().encode("not a mime frame");
    await persist({
      senderAddress: SENDER.address,
      recipients: ["usr_alice@tenant.example"],
      raw: malformed,
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.[0]).toMatchObject({
      principalId: "pri-alice",
      direction: "inbound",
    });
  });
});
