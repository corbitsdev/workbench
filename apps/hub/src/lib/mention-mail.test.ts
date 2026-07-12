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
      senderUserId: "sender-1",
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
      senderUserId: "sender-1",
      senderName: "Alice",
      content: "@[Alice](#usr_sender-1) noting this for myself",
      conversationUrl: "https://app.example/chats/1",
    });
    expect(inserted).toHaveLength(0);
  });

  it("writes a mailbox row for a resolvable mentioned member, addressed with the usr_ prefix", async () => {
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
          findFirst: mock(async () => ({ id: "prn-bob", refId: "bob-1" })),
        },
      },
    } as unknown as HubDb;

    await deliverMentionMail({
      db,
      tenantId: "ten-1",
      senderUserId: "sender-1",
      senderName: "Alice",
      content: "@[Bob](#usr_bob-1) can you take a look",
      conversationUrl: "https://app.example/chats/1",
    });

    expect(inserted).toHaveLength(1);
    const row = inserted[0] as Record<string, unknown>;
    expect(row.tenantId).toBe("ten-1");
    expect(row.principalId).toBe("prn-bob");
    expect(row.address).toBe("usr_bob-1@tenant.example");
    expect(row.fromAddress).toBe("usr_sender-1@tenant.example");
    expect(row.subject).toBe("Alice mentioned you");
    expect(row.messageKey).toMatch(/^mention:bob-1:/);
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
      senderUserId: "sender-1",
      senderName: "Alice",
      content: "@[Ghost](#usr_ghost-1) hello",
      conversationUrl: "https://app.example/chats/1",
    });
    expect(inserted).toHaveLength(0);
  });

  it("delivers nothing when the sender is not a member of the tenant", async () => {
    const inserted: Record<string, unknown>[] = [];
    const returning = mock(async () => [{ id: "row-1" }]);
    const onConflictDoNothing = mock(() => ({ returning }));
    const values = mock((row: Record<string, unknown>) => {
      inserted.push(row);
      return { onConflictDoNothing };
    });
    // Resolve principal lookups by the refId inside the drizzle expression:
    // the mentioned member exists in the tenant, the sender does not.
    const whereMentions = (node: unknown, target: string): boolean => {
      const seen = new Set<unknown>();
      const walk = (value: unknown): boolean => {
        if (typeof value === "string") return value === target;
        if (value === null || typeof value !== "object" || seen.has(value))
          return false;
        seen.add(value);
        return Object.values(value).some(walk);
      };
      return walk(node);
    };
    const db = {
      insert: mock(() => ({ values })),
      query: {
        tenant: { findFirst: mock(async () => TENANT_ROW) },
        principal: {
          findFirst: mock(async ({ where }: { where: unknown }) => {
            if (whereMentions(where, "bob-1"))
              return { id: "prn-bob", refId: "bob-1" };
            return undefined;
          }),
        },
      },
    } as unknown as HubDb;

    await deliverMentionMail({
      db,
      tenantId: "ten-other",
      senderUserId: "outsider-1",
      senderName: "Mallory",
      content: "@[Bob](#usr_bob-1) look at this",
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
        senderUserId: "sender-1",
        senderName: "Alice",
        content: "@[Bob](#usr_bob-1) hi",
        conversationUrl: "https://app.example/chats/1",
      }),
    ).resolves.toBeUndefined();
  });
});
