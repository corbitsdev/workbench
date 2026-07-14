import { createHmac } from "node:crypto";
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
import { eq } from "drizzle-orm";

const TENANT = "ten-attio-wh";
const MEMBER = "prn-attio-wh";
const SELF_ATTIO_MEMBER_ID = "actor-self-1";

// The member is opted in to the attio inbox source and has their Attio
// workspace-member id recorded (the CL-3579 assignment-gating preference).
mock.module("../lib/member-preferences", () => ({
  readMemberPreferences: async () => ({
    "inboxSource:attio": true,
    attioMemberId: SELF_ATTIO_MEMBER_ID,
  }),
}));

// tools-attio defaults to the global `fetch`; the true boundary here is the
// network call itself, mocked the same way `attio-task-sync.test.ts` mocks
// it, so the request-shaping inside `createAttioTools` still runs for real.
type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];
let responder: (url: string, init: RequestInit) => Response;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const href = url.toString();
  calls.push({ url: href, init: init ?? {} });
  return responder(href, init ?? {});
}) as typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function attioTaskRow(args: {
  id: string;
  content?: string;
  isCompleted?: boolean;
  assignees?: string[];
}) {
  return {
    id: { task_id: args.id },
    content_plaintext: args.content ?? "Follow up with Acme",
    is_completed: args.isCompleted ?? false,
    deadline_at: null,
    created_at: "2026-07-10T00:00:00.000Z",
    assignees: (args.assignees ?? []).map((id) => ({
      referenced_actor_id: id,
    })),
  };
}

const { createAttioWebhookRouter } = await import("./webhooks-attio");
import { schema } from "../db";
import type { HubDb } from "../db";
import { task } from "../db/schema";
import type { InboxIntakeMember } from "../services/inbox-source-registry";

const SECRET = "whsec_attio_test";
const DOMAIN = "wh.test";

let client: PGlite;
let db: HubDb;

const member: InboxIntakeMember = {
  tenantId: TENANT,
  memberPrincipalId: MEMBER,
  inboxAddress: `usr_wh@${DOMAIN}`,
  tenantDomain: DOMAIN,
  email: "member@corp.test",
};

// resolveMemberOrTenantToolCredential hits real DB lookups (provider row +
// oauth token) that this test does not set up; mock it at the module
// boundary the same way the route itself imports it.
mock.module("../lib/member-tool-credential", () => ({
  resolveMemberOrTenantToolCredential: async () => ({
    apiKey: "test-key",
    baseURL: "",
    source: "tenant" as const,
  }),
}));

function makeRouter(overrides?: {
  isSourceEnabledForTenant?: (t: string, s: string) => Promise<boolean>;
  members?: InboxIntakeMember[];
  now?: () => number;
}) {
  return createAttioWebhookRouter({
    db,
    secret: SECRET,
    listMembers: async () => overrides?.members ?? [member],
    isSourceEnabledForTenant:
      overrides?.isSourceEnabledForTenant ?? (async () => true),
    ...(overrides?.now ? { now: overrides.now } : {}),
  });
}

function eventEnvelope(taskId: string, eventType = "task.updated") {
  return {
    webhook_id: "wh_1",
    events: [{ event_type: eventType, id: { task_id: taskId } }],
  };
}

function signedRequest(
  app: ReturnType<typeof makeRouter>,
  body: string,
  headers?: Record<string, string>,
) {
  const signature = createHmac("sha256", SECRET).update(body).digest("hex");
  return app.request("/webhooks/attio", {
    method: "POST",
    headers: {
      "Attio-Signature": signature,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

async function tasksForMember() {
  return db.select().from(task).where(eq(task.ownerPrincipalId, MEMBER));
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
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  await client.exec(`DELETE FROM task;`);
  calls = [];
  responder = () => jsonResponse(404, { error: "not stubbed" });
});

describe("signature verification", () => {
  test("a valid signature is accepted and upserts a task", async () => {
    responder = (url) => {
      if (url.includes("/v2/tasks/task-1")) {
        return jsonResponse(200, {
          data: attioTaskRow({
            id: "task-1",
            assignees: [SELF_ATTIO_MEMBER_ID],
          }),
        });
      }
      return jsonResponse(404, {});
    };
    const body = JSON.stringify(eventEnvelope("task-1"));
    const res = await signedRequest(makeRouter(), body);
    expect(res.status).toBe(200);
    const rows = await tasksForMember();
    expect(rows.length).toBe(1);
    expect(rows[0]?.sourceRef).toBe("attio:task:task-1");
  });

  test("an invalid signature is rejected with 401 and upserts nothing", async () => {
    responder = () =>
      jsonResponse(200, {
        data: attioTaskRow({
          id: "task-2",
          assignees: [SELF_ATTIO_MEMBER_ID],
        }),
      });
    const body = JSON.stringify(eventEnvelope("task-2"));
    const res = await makeRouter().request("/webhooks/attio", {
      method: "POST",
      headers: {
        "Attio-Signature": "deadbeef",
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(401);
    expect((await tasksForMember()).length).toBe(0);
  });

  test("a missing signature header is rejected with 401", async () => {
    const res = await makeRouter().request("/webhooks/attio", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(eventEnvelope("task-3")),
    });
    expect(res.status).toBe(401);
  });

  test("the legacy X-Attio-Signature header is also accepted", async () => {
    responder = () =>
      jsonResponse(200, {
        data: attioTaskRow({
          id: "task-legacy",
          assignees: [SELF_ATTIO_MEMBER_ID],
        }),
      });
    const body = JSON.stringify(eventEnvelope("task-legacy"));
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");
    const res = await makeRouter().request("/webhooks/attio", {
      method: "POST",
      headers: {
        "X-Attio-Signature": signature,
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(200);
    expect((await tasksForMember()).length).toBe(1);
  });
});

describe("event -> upsert mapping", () => {
  test("task.created maps to a new task row", async () => {
    responder = () =>
      jsonResponse(200, {
        data: attioTaskRow({
          id: "task-created",
          assignees: [SELF_ATTIO_MEMBER_ID],
        }),
      });
    const body = JSON.stringify(eventEnvelope("task-created", "task.created"));
    const res = await signedRequest(makeRouter(), body);
    expect(res.status).toBe(200);
    expect((await tasksForMember()).length).toBe(1);
  });

  test("task.updated marking completion is reflected on the existing row", async () => {
    responder = () =>
      jsonResponse(200, {
        data: attioTaskRow({
          id: "task-done",
          assignees: [SELF_ATTIO_MEMBER_ID],
        }),
      });
    await signedRequest(
      makeRouter(),
      JSON.stringify(eventEnvelope("task-done", "task.created")),
    );
    expect((await tasksForMember())[0]?.status).toBe("open");

    responder = () =>
      jsonResponse(200, {
        data: attioTaskRow({
          id: "task-done",
          isCompleted: true,
          assignees: [SELF_ATTIO_MEMBER_ID],
        }),
      });
    await signedRequest(
      makeRouter(),
      JSON.stringify(eventEnvelope("task-done", "task.updated")),
    );
    const rows = await tasksForMember();
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("done");
  });

  test("an unattributable task (no assignee matches a known member) is dropped", async () => {
    responder = () =>
      jsonResponse(200, {
        data: attioTaskRow({
          id: "task-stranger",
          assignees: ["someone-else"],
        }),
      });
    const res = await signedRequest(
      makeRouter(),
      JSON.stringify(eventEnvelope("task-stranger")),
    );
    expect(res.status).toBe(200);
    expect((await tasksForMember()).length).toBe(0);
  });
});

describe("owner cascade gating", () => {
  test("an owner-disabled source drops the event", async () => {
    responder = () =>
      jsonResponse(200, {
        data: attioTaskRow({
          id: "task-owner-off",
          assignees: [SELF_ATTIO_MEMBER_ID],
        }),
      });
    const res = await signedRequest(
      makeRouter({ isSourceEnabledForTenant: async () => false }),
      JSON.stringify(eventEnvelope("task-owner-off")),
    );
    expect(res.status).toBe(200);
    expect((await tasksForMember()).length).toBe(0);
  });
});

describe("Idempotency-Key dedupe", () => {
  test("a redelivered Idempotency-Key is not reprocessed (no duplicate fetch/upsert)", async () => {
    responder = () =>
      jsonResponse(200, {
        data: attioTaskRow({
          id: "task-idem",
          assignees: [SELF_ATTIO_MEMBER_ID],
        }),
      });
    const body = JSON.stringify(eventEnvelope("task-idem"));
    const router = makeRouter();
    const first = await router.request("/webhooks/attio", {
      method: "POST",
      headers: {
        "Attio-Signature": createHmac("sha256", SECRET)
          .update(body)
          .digest("hex"),
        "content-type": "application/json",
        "Idempotency-Key": "idem-key-1",
      },
      body,
    });
    expect(first.status).toBe(200);
    const fetchCallsAfterFirst = calls.length;

    const second = await router.request("/webhooks/attio", {
      method: "POST",
      headers: {
        "Attio-Signature": createHmac("sha256", SECRET)
          .update(body)
          .digest("hex"),
        "content-type": "application/json",
        "Idempotency-Key": "idem-key-1",
      },
      body,
    });
    expect(second.status).toBe(200);
    expect(calls.length).toBe(fetchCallsAfterFirst); // no re-fetch on redelivery
    expect((await tasksForMember()).length).toBe(1); // no duplicate row either way
  });
});

describe("webhook + poller overlap", () => {
  test("a webhook delivery followed by a poller pass over the same task produces ONE row", async () => {
    responder = () =>
      jsonResponse(200, {
        data: attioTaskRow({
          id: "task-overlap",
          assignees: [SELF_ATTIO_MEMBER_ID],
        }),
      });
    await signedRequest(
      makeRouter(),
      JSON.stringify(eventEnvelope("task-overlap", "task.created")),
    );
    expect((await tasksForMember()).length).toBe(1);

    // The poller's own upsert path (`syncOneTask`) applied to the SAME
    // Attio task must collapse onto the same `attio:task:<id>` sourceRef
    // row rather than creating a second one.
    const { syncOneTask } = await import(
      "../services/inbox-sources/attio-task-sync"
    );
    await syncOneTask(
      db,
      member,
      {
        id: { task_id: "task-overlap" },
        content_plaintext: "Follow up with Acme",
        is_completed: false,
        deadline_at: null,
        created_at: "2026-07-10T00:00:00.000Z",
        assignees: [{ referenced_actor_id: SELF_ATTIO_MEMBER_ID }],
      },
      new Date(0),
      SELF_ATTIO_MEMBER_ID,
    );

    expect((await tasksForMember()).length).toBe(1);
  });
});
