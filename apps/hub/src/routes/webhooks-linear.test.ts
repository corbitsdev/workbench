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

// The member has the linear source enabled; owner cascade is injected true.
mock.module("../lib/member-preferences", () => ({
  readMemberPreferences: async () => ({ "inboxSource:linear": true }),
}));

const { createLinearWebhookRouter } = await import("./webhooks-linear");
const { deliverInboxItems } = await import("../lib/inbox-delivery");
const { buildIssueIntakeItem } = await import(
  "../services/inbox-sources/linear"
);
import { schema } from "../db";
import type { HubDb } from "../db";
import type { InboxIntakeMember } from "../services/inbox-source-registry";

const SECRET = "whsec_test";
const TENANT = "ten-wh";
const MEMBER = "prn-wh";
const DOMAIN = "wh.test";
const EMAIL = "assignee@corp.test";

let client: PGlite;
let db: HubDb;

const member: InboxIntakeMember = {
  tenantId: TENANT,
  memberPrincipalId: MEMBER,
  inboxAddress: `usr_wh@${DOMAIN}`,
  tenantDomain: DOMAIN,
  email: EMAIL,
};

function makeRouter(overrides?: {
  isSourceEnabledForTenant?: (t: string, s: string) => Promise<boolean>;
  members?: InboxIntakeMember[];
}) {
  return createLinearWebhookRouter({
    db,
    secret: SECRET,
    listMembers: async () => overrides?.members ?? [member],
    isSourceEnabledForTenant:
      overrides?.isSourceEnabledForTenant ?? (async () => true),
  });
}

function issuePayload(updatedAt: string, ts = Date.now()) {
  return {
    action: "update" as const,
    type: "Issue" as const,
    webhookTimestamp: ts,
    data: {
      id: "iss-wh-1",
      identifier: "ENG-42",
      title: "Webhook issue",
      url: "https://linear.app/x/issue/ENG-42",
      createdAt: "2026-07-13T09:00:00.000Z",
      updatedAt,
      state: { name: "In Progress" },
      assignee: { email: EMAIL },
    },
  };
}

function signedRequest(app: ReturnType<typeof makeRouter>, body: string) {
  const signature = createHmac("sha256", SECRET).update(body).digest("hex");
  return app.request("/webhooks/linear", {
    method: "POST",
    headers: {
      "linear-signature": signature,
      "content-type": "application/json",
    },
    body,
  });
}

async function mailboxRows() {
  return client.query<{ message_key: string }>(
    `select message_key from principal_mailbox where principal_id = $1`,
    [MEMBER],
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
  await client.exec(`DELETE FROM principal_mailbox;`);
});

describe("signature verification", () => {
  test("a valid signature is accepted and lands a mailbox row", async () => {
    const body = JSON.stringify(issuePayload("2026-07-13T10:00:00.000Z"));
    const res = await signedRequest(makeRouter(), body);
    expect(res.status).toBe(200);
    const rows = (await mailboxRows()).rows;
    expect(rows.length).toBe(1);
    expect(
      rows[0]?.message_key.startsWith("inbox:linear:issue:iss-wh-1:"),
    ).toBe(true);
  });

  test("an invalid signature is rejected with 401 and delivers nothing", async () => {
    const body = JSON.stringify(issuePayload("2026-07-13T10:00:00.000Z"));
    const res = await makeRouter().request("/webhooks/linear", {
      method: "POST",
      headers: {
        "linear-signature": "deadbeef",
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(401);
    expect((await mailboxRows()).rows.length).toBe(0);
  });

  test("a missing signature header is rejected with 401", async () => {
    const res = await makeRouter().request("/webhooks/linear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(issuePayload("2026-07-13T10:00:00.000Z")),
    });
    expect(res.status).toBe(401);
  });

  test("a stale webhookTimestamp is rejected with 401 (replay guard)", async () => {
    const stale = Date.now() - 5 * 60 * 1000;
    const body = JSON.stringify(
      issuePayload("2026-07-13T10:00:00.000Z", stale),
    );
    const res = await signedRequest(makeRouter(), body);
    expect(res.status).toBe(401);
    expect((await mailboxRows()).rows.length).toBe(0);
  });
});

describe("event routing + gating", () => {
  test("an issue assigned to no known member is dropped (200, no row)", async () => {
    const body = JSON.stringify({
      ...issuePayload("2026-07-13T10:00:00.000Z"),
      data: {
        ...issuePayload("2026-07-13T10:00:00.000Z").data,
        assignee: { email: "stranger@nope.test" },
      },
    });
    const res = await signedRequest(makeRouter(), body);
    expect(res.status).toBe(200);
    expect((await mailboxRows()).rows.length).toBe(0);
  });

  test("an owner-disabled source drops the event", async () => {
    const body = JSON.stringify(issuePayload("2026-07-13T10:00:00.000Z"));
    const res = await signedRequest(
      makeRouter({ isSourceEnabledForTenant: async () => false }),
      body,
    );
    expect(res.status).toBe(200);
    expect((await mailboxRows()).rows.length).toBe(0);
  });
});

describe("webhook + poller dedupe overlap", () => {
  test("a webhook delivery and a subsequent poll of the same issue produce ONE row", async () => {
    const updatedAt = "2026-07-13T10:00:00.000Z";
    // 1. Webhook delivers first.
    const body = JSON.stringify(issuePayload(updatedAt));
    await signedRequest(makeRouter(), body);
    expect((await mailboxRows()).rows.length).toBe(1);

    // 2. The poller later fetches the SAME issue (same id + updatedAt) and
    // delivers via the shared helper — same externalId ⇒ same messageKey.
    const pollItem = buildIssueIntakeItem(
      {
        id: "iss-wh-1",
        identifier: "ENG-42",
        title: "Webhook issue",
        url: "https://linear.app/x/issue/ENG-42",
        createdAt: "2026-07-13T09:00:00.000Z",
        updatedAt,
        state: { name: "In Progress" },
      },
      new Date("2026-07-12T00:00:00.000Z"),
    );
    await deliverInboxItems({ db }, member, "linear", [pollItem]);

    expect((await mailboxRows()).rows.length).toBe(1);
  });
});
