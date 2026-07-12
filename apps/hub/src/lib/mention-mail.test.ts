import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";
import { deliverMentionMail } from "./mention-mail";

const TENANT_ROW = { id: "ten-1", domain: "tenant.example" };

function makeDb(opts: {
  members: Record<string, { id: string; refId: string }>;
}) {
  const inserted: Record<string, unknown>[] = [];
  const returning = mock(async () => [{ id: "row-1" }]);
  const onConflictDoNothing = mock(() => ({ returning }));
  const values = mock((row: Record<string, unknown>) => {
    inserted.push(row);
    return { onConflictDoNothing };
  });
  const db = {
    insert: mock(() => ({ values })),
    query: {
      tenant: { findFirst: mock(async () => TENANT_ROW) },
      principal: {
        findFirst: mock(async ({ where }: { where: unknown }) => {
          // The test doubles resolve by refId embedded in the mock call site
          // below rather than parsing the drizzle `where` expression.
          void where;
          return undefined;
        }),
      },
    },
  } as unknown as HubDb;
  return { db, inserted, opts };
}

describe("deliverMentionMail", () => {
  it("does nothing when the message has no mentions", async () => {
    const { db, inserted } = makeDb({ members: {} });
    await deliverMentionMail({
      db,
      tenantId: "ten-1",
      senderUserId: "usr_sender",
      senderName: "Alice",
      content: "no mentions here",
      conversationUrl: "https://app.example/chats/1",
    });
    expect(inserted).toHaveLength(0);
  });

  it("skips a self-mention without writing mail", async () => {
    const { db, inserted } = makeDb({ members: {} });
    await deliverMentionMail({
      db,
      tenantId: "ten-1",
      senderUserId: "usr_sender",
      senderName: "Alice",
      content: "@[Alice](#usr_sender) noting this for myself",
      conversationUrl: "https://app.example/chats/1",
    });
    expect(inserted).toHaveLength(0);
  });

  it("writes a mailbox row for a resolvable mentioned member", async () => {
    const inserted: Record<string, unknown>[] = [];
    const returning = mock(async () => [{ id: "row-1" }]);
    const onConflictDoNothing = mock(() => ({ returning }));
    const values = mock((row: Record<string, unknown>) => {
      inserted.push(row);
      return { onConflictDoNothing };
    });
    const db = {
      insert: mock(() => ({ values })),
      query: {
        tenant: { findFirst: mock(async () => TENANT_ROW) },
        principal: {
          findFirst: mock(async () => ({ id: "prn-bob", refId: "usr_bob" })),
        },
      },
    } as unknown as HubDb;

    await deliverMentionMail({
      db,
      tenantId: "ten-1",
      senderUserId: "usr_sender",
      senderName: "Alice",
      content: "@[Bob](#usr_bob) can you take a look",
      conversationUrl: "https://app.example/chats/1",
    });

    expect(inserted).toHaveLength(1);
    const row = inserted[0] as Record<string, unknown>;
    expect(row.tenantId).toBe("ten-1");
    expect(row.principalId).toBe("prn-bob");
    expect(row.address).toBe("usr_bob@tenant.example");
    expect(row.subject).toBe("Alice mentioned you");
    expect(row.messageKey).toMatch(/^mention:usr_bob:/);
  });

  it("skips a mentioned id that does not resolve to a tenant member", async () => {
    const inserted: Record<string, unknown>[] = [];
    const returning = mock(async () => [{ id: "row-1" }]);
    const onConflictDoNothing = mock(() => ({ returning }));
    const values = mock((row: Record<string, unknown>) => {
      inserted.push(row);
      return { onConflictDoNothing };
    });
    const db = {
      insert: mock(() => ({ values })),
      query: {
        tenant: { findFirst: mock(async () => TENANT_ROW) },
        principal: { findFirst: mock(async () => undefined) },
      },
    } as unknown as HubDb;

    await deliverMentionMail({
      db,
      tenantId: "ten-1",
      senderUserId: "usr_sender",
      senderName: "Alice",
      content: "@[Ghost](#usr_ghost) hello",
      conversationUrl: "https://app.example/chats/1",
    });
    expect(inserted).toHaveLength(0);
  });

  it("never throws when the db lookup fails", async () => {
    const db = {
      query: {
        tenant: {
          findFirst: mock(() => Promise.reject(new Error("db down"))),
        },
      },
    } as unknown as HubDb;

    await expect(
      deliverMentionMail({
        db,
        tenantId: "ten-1",
        senderUserId: "usr_sender",
        senderName: "Alice",
        content: "@[Bob](#usr_bob) hi",
        conversationUrl: "https://app.example/chats/1",
      }),
    ).resolves.toBeUndefined();
  });
});
