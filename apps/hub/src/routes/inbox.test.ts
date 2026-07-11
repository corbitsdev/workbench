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
  getRootTenantId: mock(async () => "ten-1"),
  lookupMember: mock(async () => member),
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

const listUserMailbox = mock(
  async (
    _db: unknown,
    _scope: { tenantId: string; principalId: string; limit: number },
  ) => [canned],
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
import { createInboxRouter } from "./inbox";

function mountApp() {
  const app = new Hono();
  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use("*", async (c, next) => {
    c.set("userId", c.req.header("x-test-user-id") ?? "user-a");
    await next();
  });
  v1.route("/", createInboxRouter({} as unknown as HubDb));
  app.route("/api/v1", v1);
  return app;
}

beforeEach(() => {
  member = { tenantId: "ten-1", principalId: "pri-a" };
  markReadResult = true;
  detailResult = cannedDetail;
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
