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

const { createSlackWebhookRouter } = await import("./webhooks-slack");
import { inboxSourcePreferenceKey } from "@workbench/shared";
import { schema } from "../db";
import type { HubDb } from "../db";
import type { InboxIntakeMember } from "../services/inbox-source-registry";
import type { SlackCredential } from "../lib/slack-api-client";
import { mergeMemberPreferences } from "../lib/member-preferences";
import { createEmailMemberResolver } from "../lib/slack-member-mapping";
import { createSlackEventDedupe } from "../lib/slack-event-dedupe";

const SECRET = "slack-signing-secret";
const TENANT = "ten-slack";
const MEMBER = "prn-slack";
const DOMAIN = "slack.test";
const EMAIL = "person@corp.test";
const SLACK_USER_ID = "U0123ABCD";

let client: PGlite;
let db: HubDb;

const member: InboxIntakeMember = {
  tenantId: TENANT,
  memberPrincipalId: MEMBER,
  inboxAddress: `usr_slack@${DOMAIN}`,
  tenantDomain: DOMAIN,
  email: EMAIL,
};

const FAKE_CREDENTIAL: SlackCredential = {
  botToken: "xoxb-fake",
  baseUrl: "https://slack.example/api",
};

function signedHeaders(
  body: string,
  ts = String(Math.floor(Date.now() / 1000)),
) {
  const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return {
    "x-slack-signature": sig,
    "x-slack-request-timestamp": ts,
    "content-type": "application/json",
  };
}

function makeRouter(overrides?: {
  isSourceEnabledForTenant?: (t: string, s: string) => Promise<boolean>;
  members?: InboxIntakeMember[];
  lookupEmail?: (
    tenantId: string,
    slackUserId: string,
  ) => Promise<string | null>;
  resolveCredential?: (tenantId: string) => Promise<SlackCredential | null>;
  resolveTenantForTeam?: (teamId: string) => Promise<string | null>;
}) {
  const listMembers = async () => overrides?.members ?? [member];
  const memberResolver = createEmailMemberResolver({
    listMembers,
    lookupEmail:
      overrides?.lookupEmail ??
      (async (_tenantId, slackUserId) =>
        slackUserId === SLACK_USER_ID ? EMAIL : null),
  });
  return createSlackWebhookRouter({
    db,
    signingSecret: SECRET,
    listMembers,
    isSourceEnabledForTenant:
      overrides?.isSourceEnabledForTenant ?? (async () => true),
    resolveCredential:
      overrides?.resolveCredential ?? (async () => FAKE_CREDENTIAL),
    resolveTenantForTeam:
      overrides?.resolveTenantForTeam ??
      (async (teamId) => (teamId === "T0TEAM" ? TENANT : null)),
    memberResolver,
    dedupe: createSlackEventDedupe(),
  });
}

function messagePayload(args: {
  eventId: string;
  text: string;
  ts?: string;
  channel?: string;
}) {
  return {
    type: "event_callback",
    team_id: "T0TEAM",
    event_id: args.eventId,
    event: {
      type: "message",
      channel: args.channel ?? "C0GENERAL",
      user: "U9OTHER",
      text: args.text,
      ts: args.ts ?? "1699999999.000100",
    },
  };
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
  await client.exec(`DELETE FROM member_preferences;`);
  // Member default for `inboxSource:slack` is OFF (CL-3581); most tests in
  // this file exercise mention delivery, so opt the fixture member in here
  // and test the OFF-by-default / explicit-disable paths separately.
  await mergeMemberPreferences(db, TENANT, MEMBER, {
    [inboxSourcePreferenceKey("slack")]: true,
  });
});

describe("url_verification", () => {
  test("echoes the challenge when the signature is valid", async () => {
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "abc123",
      token: "tok",
    });
    const res = await makeRouter().request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc123" });
  });
});

describe("signature verification", () => {
  test("an invalid signature is rejected with 401", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const res = await makeRouter().request("/webhooks/slack", {
      method: "POST",
      headers: {
        "x-slack-signature": "v0=deadbeef",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  test("a missing signature is rejected with 401", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const res = await makeRouter().request("/webhooks/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
  });

  test("a stale timestamp is rejected with 401 (replay guard)", async () => {
    const body = JSON.stringify(
      messagePayload({ eventId: "ev-stale", text: `hi <@${SLACK_USER_ID}>` }),
    );
    const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const res = await makeRouter().request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body, stale),
      body,
    });
    expect(res.status).toBe(401);
    expect((await mailboxRows()).rows.length).toBe(0);
  });
});

describe("mention routing + delivery", () => {
  test("a mention of a matched member lands one mailbox row", async () => {
    const body = JSON.stringify(
      messagePayload({
        eventId: "ev-1",
        text: `hey <@${SLACK_USER_ID}> check this`,
      }),
    );
    const res = await makeRouter().request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    const rows = (await mailboxRows()).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]?.message_key.startsWith("inbox:slack:T0TEAM:")).toBe(true);
  });

  // Pins the exact pre-CL-3577-overhaul messageKey format
  // (`inbox:slack:<teamId>:<channel>:<ts>`) now that delivery is routed
  // through the shared `deliverInboxItems` helper — a drift here would
  // re-deliver already-delivered mentions.
  test("the messageKey is exactly inbox:slack:<teamId>:<channel>:<ts>", async () => {
    const body = JSON.stringify(
      messagePayload({
        eventId: "ev-key-pin",
        text: `hey <@${SLACK_USER_ID}>`,
        channel: "C0PINNED",
        ts: "1700000000.000200",
      }),
    );
    const res = await makeRouter().request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    const rows = (await mailboxRows()).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]?.message_key).toBe(
      "inbox:slack:T0TEAM:C0PINNED:1700000000.000200",
    );
  });

  test("a mention of an unmatched slack user is dropped (200, no row)", async () => {
    const body = JSON.stringify(
      messagePayload({ eventId: "ev-2", text: "hey <@USTRANGER> check this" }),
    );
    const res = await makeRouter().request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    expect((await mailboxRows()).rows.length).toBe(0);
  });

  test("an owner-disabled source drops the event", async () => {
    const body = JSON.stringify(
      messagePayload({ eventId: "ev-3", text: `hey <@${SLACK_USER_ID}>` }),
    );
    const res = await makeRouter({
      isSourceEnabledForTenant: async () => false,
    }).request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    expect((await mailboxRows()).rows.length).toBe(0);
  });

  test("a message with no mention is dropped", async () => {
    const body = JSON.stringify(
      messagePayload({ eventId: "ev-4", text: "no mention here" }),
    );
    const res = await makeRouter().request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    expect((await mailboxRows()).rows.length).toBe(0);
  });
});

describe("team_id → tenant routing (CL-3629)", () => {
  test("an event from a mapped team routes to that team's tenant", async () => {
    const body = JSON.stringify(
      messagePayload({
        eventId: "ev-team-mapped",
        text: `hey <@${SLACK_USER_ID}>`,
      }),
    );
    const res = await makeRouter({
      resolveTenantForTeam: async (teamId) =>
        teamId === "T0TEAM" ? TENANT : null,
    }).request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    expect((await mailboxRows()).rows.length).toBe(1);
  });

  test("an event from an unmapped team is dropped (200, no row)", async () => {
    const body = JSON.stringify(
      messagePayload({
        eventId: "ev-team-unmapped",
        text: `hey <@${SLACK_USER_ID}>`,
      }),
    );
    const res = await makeRouter({
      resolveTenantForTeam: async () => null,
    }).request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    expect((await mailboxRows()).rows.length).toBe(0);
  });

  test("two tenants with distinct team ids route independently", async () => {
    const TENANT_B = "ten-slack-b";
    const MEMBER_B = "prn-slack-b";
    const memberB: InboxIntakeMember = {
      tenantId: TENANT_B,
      memberPrincipalId: MEMBER_B,
      inboxAddress: `usr_slack_b@${DOMAIN}`,
      tenantDomain: DOMAIN,
      email: "person-b@corp.test",
    };
    await mergeMemberPreferences(db, TENANT_B, MEMBER_B, {
      [inboxSourcePreferenceKey("slack")]: true,
    });

    const listMembers = async () => [member, memberB];
    const memberResolver = createEmailMemberResolver({
      listMembers,
      lookupEmail: async (tenantId, slackUserId) => {
        if (tenantId === TENANT && slackUserId === SLACK_USER_ID) return EMAIL;
        if (tenantId === TENANT_B && slackUserId === "UBSLACK")
          return "person-b@corp.test";
        return null;
      },
    });
    const router = createSlackWebhookRouter({
      db,
      signingSecret: SECRET,
      listMembers,
      isSourceEnabledForTenant: async () => true,
      resolveCredential: async () => FAKE_CREDENTIAL,
      resolveTenantForTeam: async (teamId) => {
        if (teamId === "T0TEAM") return TENANT;
        if (teamId === "T1TEAM") return TENANT_B;
        return null;
      },
      memberResolver,
      dedupe: createSlackEventDedupe(),
    });

    const bodyA = JSON.stringify({
      type: "event_callback",
      team_id: "T0TEAM",
      event_id: "ev-multi-a",
      event: {
        type: "message",
        channel: "C0GENERAL",
        user: "U9OTHER",
        text: `hey <@${SLACK_USER_ID}>`,
        ts: "1700000001.000100",
      },
    });
    const bodyB = JSON.stringify({
      type: "event_callback",
      team_id: "T1TEAM",
      event_id: "ev-multi-b",
      event: {
        type: "message",
        channel: "C1GENERAL",
        user: "U9OTHER",
        text: "hey <@UBSLACK>",
        ts: "1700000002.000100",
      },
    });

    const resA = await router.request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(bodyA),
      body: bodyA,
    });
    const resB = await router.request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(bodyB),
      body: bodyB,
    });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const rowsA = await client.query<{ message_key: string }>(
      `select message_key from principal_mailbox where principal_id = $1`,
      [MEMBER],
    );
    const rowsB = await client.query<{ message_key: string }>(
      `select message_key from principal_mailbox where principal_id = $1`,
      [MEMBER_B],
    );
    expect(rowsA.rows.length).toBe(1);
    expect(rowsB.rows.length).toBe(1);
    expect(rowsA.rows[0]?.message_key).toBe(
      "inbox:slack:T0TEAM:C0GENERAL:1700000001.000100",
    );
    expect(rowsB.rows[0]?.message_key).toBe(
      "inbox:slack:T1TEAM:C1GENERAL:1700000002.000100",
    );
  });
});

describe("member-level inboxSource:slack gate (CL-3581)", () => {
  test("a member with the preference disabled has the mention dropped", async () => {
    await mergeMemberPreferences(db, TENANT, MEMBER, {
      [inboxSourcePreferenceKey("slack")]: false,
    });
    const body = JSON.stringify(
      messagePayload({
        eventId: "ev-pref-off",
        text: `hey <@${SLACK_USER_ID}>`,
      }),
    );
    const res = await makeRouter().request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    expect((await mailboxRows()).rows.length).toBe(0);
  });

  test("a member with no stored preference (default OFF) has the mention dropped", async () => {
    await client.exec(`DELETE FROM member_preferences;`);
    const body = JSON.stringify(
      messagePayload({
        eventId: "ev-pref-unset",
        text: `hey <@${SLACK_USER_ID}>`,
      }),
    );
    const res = await makeRouter().request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    expect((await mailboxRows()).rows.length).toBe(0);
  });

  test("a member with the preference enabled has the mention delivered", async () => {
    const body = JSON.stringify(
      messagePayload({
        eventId: "ev-pref-on",
        text: `hey <@${SLACK_USER_ID}>`,
      }),
    );
    const res = await makeRouter().request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    expect((await mailboxRows()).rows.length).toBe(1);
  });
});

describe("event-id dedupe", () => {
  test("the same event id delivered twice is processed only once", async () => {
    const body = JSON.stringify(
      messagePayload({ eventId: "ev-dupe", text: `hey <@${SLACK_USER_ID}>` }),
    );
    const router = makeRouter();
    const first = await router.request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    const second = await router.request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await mailboxRows()).rows.length).toBe(1);
  });
});

describe("channel_created auto-join", () => {
  test("triggers a join call for the new channel", async () => {
    const joinCalls: string[] = [];
    mock.module("../lib/slack-channel-autojoin", () => ({
      joinNewlyCreatedChannel: async (
        _credential: SlackCredential,
        channelId: string,
      ) => {
        joinCalls.push(channelId);
      },
    }));
    const { createSlackWebhookRouter: freshRouter } = await import(
      "./webhooks-slack"
    );
    const listMembers = async () => [member];
    const router = freshRouter({
      db,
      signingSecret: SECRET,
      listMembers,
      isSourceEnabledForTenant: async () => true,
      resolveCredential: async () => FAKE_CREDENTIAL,
      resolveTenantForTeam: async (teamId) =>
        teamId === "T0TEAM" ? TENANT : null,
      dedupe: createSlackEventDedupe(),
    });
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T0TEAM",
      event_id: "ev-channel-created",
      event: {
        type: "channel_created",
        channel: { id: "C0NEW", name: "new-channel" },
      },
    });
    const res = await router.request("/webhooks/slack", {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    expect(joinCalls).toEqual(["C0NEW"]);
  });
});
