import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { MailboxMessage, MailboxMessageDetail } from "@workbench/shared";
import {
  MailboxListResponse,
  MailboxMessageDetail as MailboxMessageDetailSchema,
} from "@workbench/shared";
import { type } from "arktype";

let member: { tenantId: string; principalId: string } | null = null;

mock.module("../config", () => ({ getConfig: () => ({}) }));
mock.module("../lib/tenant-provisioning", () => ({
  resolveCallerMember: mock(async () => member),
}));

const canned: MailboxMessage = {
  id: "5e0f8c9a-0000-4000-8000-000000000001",
  from: "ins_dep-heartbeat@tenant.example",
  to: ["usr_alice@tenant.example"],
  subject: "Morning brief",
  date: "2026-07-10T07:00:00.000Z",
  messageId: "<m1@tenant.example>",
  snippet: "Your brief is ready.",
  read: false,
};

const cannedDetail: MailboxMessageDetail = {
  ...canned,
  body: "Your brief is ready.\n\n- pipeline moved\n- two calls today",
};

let mailboxPage: { items: MailboxMessage[]; nextCursor?: string } = {
  items: [canned],
};
const listUserMailbox = mock(
  async (
    _db: unknown,
    _scope: {
      tenantId: string;
      principalId: string;
      limit: number;
      cursor?: { createdAt: string; id: string };
    },
  ) => mailboxPage,
);
let markReadResult = true;
const markMailboxMessageRead = mock(
  async (
    _db: unknown,
    _args: { tenantId: string; principalId: string; id: string },
  ) => markReadResult,
);
let detailResult: MailboxMessageDetail | null = null;
const getMailboxMessage = mock(
  async (
    _db: unknown,
    _args: { tenantId: string; principalId: string; id: string },
  ) => detailResult,
);
mock.module("../lib/mailbox-read", () => ({
  listUserMailbox,
  markMailboxMessageRead,
  getMailboxMessage,
}));

import { Hono } from "hono";
import type { HubDb } from "../db";
import { encodeCursor } from "../lib/keyset";
import { createInboxRouter } from "./inbox";
import {
  createMailboxEventBus,
  type MailboxEventBus,
} from "../lib/mailbox-events";

function mountApp(bus: MailboxEventBus = createMailboxEventBus()) {
  const app = new Hono();
  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use("*", async (c, next) => {
    c.set("userId", c.req.header("x-test-user-id") ?? "user-a");
    await next();
  });
  v1.route("/", createInboxRouter({} as unknown as HubDb, bus));
  app.route("/api/v1", v1);
  return app;
}

beforeEach(() => {
  member = { tenantId: "ten-1", principalId: "pri-a" };
  markReadResult = true;
  detailResult = cannedDetail;
  mailboxPage = { items: [canned] };
  listUserMailbox.mockClear();
  markMailboxMessageRead.mockClear();
  getMailboxMessage.mockClear();
});

describe("GET /me/inbox", () => {
  it("returns the caller's messages in the shared contract shape", async () => {
    const res = await mountApp().request(
      new Request("http://localhost/api/v1/me/inbox"),
    );
    expect(res.status).toBe(200);
    const body = MailboxListResponse(await res.json());
    expect(body instanceof type.errors).toBe(false);
    expect(body).toEqual({ messages: [canned] });
  });

  it("scopes the read to the calling member's own principal", async () => {
    const app = mountApp();
    await app.request(
      new Request("http://localhost/api/v1/me/inbox", {
        headers: { "x-test-user-id": "user-a" },
      }),
    );
    expect(listUserMailbox.mock.calls[0]?.[1]).toMatchObject({
      tenantId: "ten-1",
      principalId: "pri-a",
    });

    // Member B's request resolves B's principal — the query scope is always
    // the caller's own membership, never another member's.
    member = { tenantId: "ten-1", principalId: "pri-b" };
    await app.request(
      new Request("http://localhost/api/v1/me/inbox", {
        headers: { "x-test-user-id": "user-b" },
      }),
    );
    expect(listUserMailbox.mock.calls[1]?.[1]).toMatchObject({
      principalId: "pri-b",
    });
    const scopes = listUserMailbox.mock.calls.map(
      (call) => call[1]?.principalId,
    );
    expect(scopes).toEqual(["pri-a", "pri-b"]);
  });

  it("409s when the caller has no provisioned membership", async () => {
    member = null;
    const res = await mountApp().request(
      new Request("http://localhost/api/v1/me/inbox"),
    );
    expect(res.status).toBe(409);
    expect(listUserMailbox.mock.calls).toHaveLength(0);
  });

  it("passes a valid limit through and rejects an invalid one", async () => {
    const app = mountApp();
    const ok = await app.request(
      new Request("http://localhost/api/v1/me/inbox?limit=5"),
    );
    expect(ok.status).toBe(200);
    expect(listUserMailbox.mock.calls[0]?.[1]).toMatchObject({ limit: 5 });

    const bad = await app.request(
      new Request("http://localhost/api/v1/me/inbox?limit=nope"),
    );
    expect(bad.status).toBe(400);
  });

  it("decodes a valid cursor and forwards the keyset position to the store", async () => {
    const cursor = encodeCursor({
      createdAt: new Date("2026-07-10T07:00:00.000Z"),
      id: "5e0f8c9a-0000-4000-8000-000000000001",
    });
    const res = await mountApp().request(
      new Request(
        `http://localhost/api/v1/me/inbox?cursor=${encodeURIComponent(cursor)}`,
      ),
    );
    expect(res.status).toBe(200);
    expect(listUserMailbox.mock.calls[0]?.[1]?.cursor).toEqual({
      createdAt: "2026-07-10T07:00:00.000Z",
      id: "5e0f8c9a-0000-4000-8000-000000000001",
    });
  });

  it("400s on a malformed cursor without touching the store", async () => {
    const res = await mountApp().request(
      new Request("http://localhost/api/v1/me/inbox?cursor=not-a-valid-cursor"),
    );
    expect(res.status).toBe(400);
    expect(listUserMailbox.mock.calls).toHaveLength(0);
  });

  it("surfaces nextCursor only when the store reports another page", async () => {
    mailboxPage = { items: [canned], nextCursor: "opaque-next" };
    const res = await mountApp().request(
      new Request("http://localhost/api/v1/me/inbox"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messages: [canned],
      nextCursor: "opaque-next",
    });
  });
});

describe("GET /me/inbox/:id", () => {
  const id = "5e0f8c9a-0000-4000-8000-000000000001";

  it("returns the full body and ISO date in the shared detail contract", async () => {
    const res = await mountApp().request(
      new Request(`http://localhost/api/v1/me/inbox/${id}`),
    );
    expect(res.status).toBe(200);
    const body = MailboxMessageDetailSchema(await res.json());
    expect(body instanceof type.errors).toBe(false);
    expect(body).toEqual(cannedDetail);
  });

  it("scopes the lookup to the calling member's own principal", async () => {
    const app = mountApp();
    await app.request(
      new Request(`http://localhost/api/v1/me/inbox/${id}`, {
        headers: { "x-test-user-id": "user-a" },
      }),
    );
    expect(getMailboxMessage.mock.calls[0]?.[1]).toEqual({
      tenantId: "ten-1",
      principalId: "pri-a",
      id,
    });

    // Member B's read resolves B's principal — B can never read A's mail.
    member = { tenantId: "ten-1", principalId: "pri-b" };
    detailResult = null;
    const res = await app.request(
      new Request(`http://localhost/api/v1/me/inbox/${id}`, {
        headers: { "x-test-user-id": "user-b" },
      }),
    );
    expect(res.status).toBe(404);
    expect(getMailboxMessage.mock.calls[1]?.[1]).toMatchObject({
      principalId: "pri-b",
    });
  });

  it("404s when the message is not in the caller's mailbox", async () => {
    detailResult = null;
    const res = await mountApp().request(
      new Request(`http://localhost/api/v1/me/inbox/${id}`),
    );
    expect(res.status).toBe(404);
  });

  it("400s on a non-uuid message id without touching the db", async () => {
    const res = await mountApp().request(
      new Request("http://localhost/api/v1/me/inbox/not-a-uuid"),
    );
    expect(res.status).toBe(400);
    expect(getMailboxMessage.mock.calls).toHaveLength(0);
  });

  it("409s when the caller has no provisioned membership", async () => {
    member = null;
    const res = await mountApp().request(
      new Request(`http://localhost/api/v1/me/inbox/${id}`),
    );
    expect(res.status).toBe(409);
    expect(getMailboxMessage.mock.calls).toHaveLength(0);
  });
});

describe("POST /me/inbox/:id/read", () => {
  const id = "5e0f8c9a-0000-4000-8000-000000000001";

  it("marks the caller's message read", async () => {
    const res = await mountApp().request(
      new Request(`http://localhost/api/v1/me/inbox/${id}/read`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, read: true });
    expect(markMailboxMessageRead.mock.calls[0]?.[1]).toEqual({
      tenantId: "ten-1",
      principalId: "pri-a",
      id,
    });
  });

  it("404s when the message is not in the caller's mailbox", async () => {
    markReadResult = false;
    const res = await mountApp().request(
      new Request(`http://localhost/api/v1/me/inbox/${id}/read`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("400s on a non-uuid message id without touching the db", async () => {
    const res = await mountApp().request(
      new Request("http://localhost/api/v1/me/inbox/not-a-uuid/read", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
    expect(markMailboxMessageRead.mock.calls).toHaveLength(0);
  });

  it("409s when the caller has no provisioned membership", async () => {
    member = null;
    const res = await mountApp().request(
      new Request(`http://localhost/api/v1/me/inbox/${id}/read`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(409);
  });
});

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<string> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("stream read timed out")), ms),
  );
  const { value } = await Promise.race([reader.read(), timeout]);
  return value ? new TextDecoder().decode(value) : "";
}

describe("GET /me/inbox/events", () => {
  it("409s when the caller has no provisioned membership", async () => {
    member = null;
    const res = await mountApp().request(
      new Request("http://localhost/api/v1/me/inbox/events"),
    );
    expect(res.status).toBe(409);
  });

  it("streams a mailbox signal published for the caller's own principal", async () => {
    const bus = createMailboxEventBus();
    const app = mountApp(bus);
    const res = await app.request(
      new Request("http://localhost/api/v1/me/inbox/events", {
        headers: { "x-test-user-id": "user-a" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader =
      res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    bus.publish("pri-a", { type: "mailbox", id: "row-1" });

    const frame = await readWithTimeout(reader, 1000);
    expect(frame).toContain("event: mailbox");
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    const payload = JSON.parse(dataLine!.replace(/^data:\s*/, "")) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({ type: "mailbox", id: "row-1" });

    await reader.cancel().catch(() => {});
  });

  it("does not deliver a signal published for another principal", async () => {
    const bus = createMailboxEventBus();
    member = { tenantId: "ten-1", principalId: "pri-a" };
    const app = mountApp(bus);
    const res = await app.request(
      new Request("http://localhost/api/v1/me/inbox/events", {
        headers: { "x-test-user-id": "user-a" },
      }),
    );
    const reader =
      res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    bus.publish("pri-b", { type: "mailbox", id: "row-1" });

    const frame = await readWithTimeout(reader, 200).catch(() => "");
    expect(frame).toBe("");

    await reader.cancel().catch(() => {});
  });

  it("cleans up its subscription when the connection aborts", async () => {
    const realBus = createMailboxEventBus();
    let subscribed = false;
    let unsubscribed = false;
    const bus: MailboxEventBus = {
      publish: (principalId, event) => realBus.publish(principalId, event),
      subscribe: (principalId, listener) => {
        const off = realBus.subscribe(principalId, listener);
        subscribed = true;
        return () => {
          unsubscribed = true;
          off();
        };
      },
    };
    const app = mountApp(bus);
    const controller = new AbortController();
    const res = await app.request(
      new Request("http://localhost/api/v1/me/inbox/events", {
        headers: { "x-test-user-id": "user-a" },
        signal: controller.signal,
      }),
    );
    const reader =
      res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    for (let i = 0; i < 100 && !subscribed; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(subscribed).toBe(true);

    await reader.cancel().catch(() => {});
    controller.abort();
    for (let i = 0; i < 50 && !unsubscribed; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(unsubscribed).toBe(true);
  });
});
