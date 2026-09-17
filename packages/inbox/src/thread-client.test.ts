import { describe, expect, test } from "bun:test";

import {
  MailboxThreadFetchError,
  listMailboxThreadsClient,
  readMailboxThreadClient,
} from "./thread-client";

function fetchStub(body: unknown, status = 200): typeof fetch {
  return (async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe("listMailboxThreadsClient", () => {
  test("parses a page of thread summaries", async () => {
    const page = await listMailboxThreadsClient(
      "/api/tenants/t1/mailbox",
      { refs: [{ kind: "workbench", id: "w1" }], limit: 10 },
      fetchStub({
        threads: [
          {
            rootId: "m1",
            rootMessageId: "m1@mailbox",
            messageCount: 2,
            unreadCount: 1,
            lastMessageId: "m2@mailbox",
            lastFromAddress: "routine:x",
            lastCreatedAt: "2026-01-01T00:00:00.000000Z",
          },
        ],
        nextCursor: "cur1",
      }),
    );
    expect(page.threads).toHaveLength(1);
    expect(page.nextCursor).toBe("cur1");
  });

  test("throws MailboxThreadFetchError on a malformed body", async () => {
    await expect(
      listMailboxThreadsClient(
        "/api/tenants/t1/mailbox",
        {},
        fetchStub({ threads: "not-an-array" }),
      ),
    ).rejects.toBeInstanceOf(MailboxThreadFetchError);
  });

  test("throws MailboxThreadFetchError on a non-ok response", async () => {
    await expect(
      listMailboxThreadsClient(
        "/api/tenants/t1/mailbox",
        {},
        fetchStub({ error: "bad refs" }, 400),
      ),
    ).rejects.toBeInstanceOf(MailboxThreadFetchError);
  });
});

describe("readMailboxThreadClient", () => {
  test("parses a thread's messages oldest-first", async () => {
    const page = await readMailboxThreadClient(
      "/api/tenants/t1/mailbox",
      "root@mailbox",
      {},
      fetchStub({
        messages: [
          {
            id: "m1",
            messageId: "m1@mailbox",
            references: [],
            fromAddress: "routine:x",
            createdAt: "2026-01-01T00:00:00.000000Z",
            read: true,
            archived: false,
            parentId: null,
          },
        ],
      }),
    );
    expect(page.messages).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
  });

  test("404 surfaces as MailboxThreadFetchError", async () => {
    await expect(
      readMailboxThreadClient(
        "/api/tenants/t1/mailbox",
        "unknown@mailbox",
        {},
        fetchStub({ error: "Thread not found" }, 404),
      ),
    ).rejects.toBeInstanceOf(MailboxThreadFetchError);
  });
});
