// Mounts `createChatRoutes` into a bare `Hono` with fake platform/store
// deps, exercising the full HTTP surface without a database or a real
// hub. Grant checks are exercised via a `requireGrant` fake that can be
// told to deny, so the "unauthorized" path is covered without a real
// `GrantStore`.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import { createChatRoutes } from "../src/routes";
import type { ChatPlatform, CreateChatRoutesDeps } from "../src/routes";
import { createInMemoryChatStore } from "../src/store";
import type { Part } from "../src/parts";
import { decodeParts, type MailContent } from "../src/codec";

const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function principal(id: string) {
  return {
    id,
    tenantId: TENANT.id,
    kind: "user" as const,
    refId: id,
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakePlatform(
  opts: {
    invitable?: { id: string; name: string }[];
    launchInvite?: (input: {
      tenantId: string;
      creatorPrincipalId: string;
      definitionId: string;
    }) => Promise<{ instanceId: string; address: string }>;
  } = {},
): ChatPlatform & {
  sentMail: {
    channelId: string;
    principalId: string;
    content: MailContent;
    fromChannelId?: string;
  }[];
  launchInviteCalls: {
    tenantId: string;
    creatorPrincipalId: string;
    definitionId: string;
  }[];
  replyBridges: {
    tenantId: string;
    channelId: string;
    agentChannelId: string;
  }[];
} {
  const replyBridges: {
    tenantId: string;
    channelId: string;
    agentChannelId: string;
  }[] = [];
  const sentMail: {
    channelId: string;
    principalId: string;
    content: MailContent;
    fromChannelId?: string;
  }[] = [];
  const launchInviteCalls: {
    tenantId: string;
    creatorPrincipalId: string;
    definitionId: string;
  }[] = [];
  const mailByChannel = new Map<
    string,
    { id: string; createdAt: string; mail: unknown }[]
  >();
  let mailCounter = 0;

  return {
    sentMail,
    replyBridges,
    launchInviteCalls,
    async launchChannel() {
      return { instanceId: "launched" };
    },
    async launchInvite(input) {
      launchInviteCalls.push(input);
      if (opts.launchInvite !== undefined) return opts.launchInvite(input);
      return {
        instanceId: "ins_invited1",
        address: "ins_invited1@acme.example",
      };
    },
    async listInvitableDefinitions() {
      return opts.invitable ?? [];
    },
    async sendMail(input) {
      sentMail.push({
        channelId: input.channelId,
        principalId: input.principalId,
        content: input.content,
        ...(input.fromChannelId !== undefined
          ? { fromChannelId: input.fromChannelId }
          : {}),
      });
      const id = `mail_${++mailCounter}`;
      const createdAt = new Date().toISOString();
      const list = mailByChannel.get(input.channelId) ?? [];
      list.push({
        id,
        createdAt,
        mail: {
          textBody: [{ partId: "1", type: "text/plain" }],
          bodyValues: { "1": { value: input.content.content } },
          attachments: [],
          from: [{ name: null, email: `${input.principalId}@acme.example` }],
        },
      });
      mailByChannel.set(input.channelId, list);
      return { id, createdAt };
    },
    async listMail(input) {
      // Matches the real platform's contract: a page is newest-first.
      const items = mailByChannel.get(input.channelId) ?? [];
      return { items: [...items].reverse() };
    },
    async fetchBlob() {
      return "";
    },
    subscribeToChannel() {
      return () => undefined;
    },
    ensureReplyBridge(input: {
      tenantId: string;
      channelId: string;
      agentChannelId: string;
    }) {
      replyBridges.push(input);
    },
  };
}

function mountAs(
  routes: Hono<TenantEnv>,
  principalId: string,
): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", principal(principalId));
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

function buildDeps(
  overrides: Partial<CreateChatRoutesDeps> = {},
): CreateChatRoutesDeps {
  return {
    store: createInMemoryChatStore(),
    platform: fakePlatform(),
    requireGrant: () => async (_c, next) => {
      await next();
    },
    turnTimeoutMs: 60_000,
    channelHostInferencePreferences: [
      { provider: "anthropic", model: "claude-sonnet-5" },
    ],
    ...overrides,
  };
}

interface ChannelView {
  id: string;
  title: string;
  kind: string;
  pinned: boolean;
  participants: { address: string; handle: string }[];
}

async function createChannel(
  app: Hono<TenantEnv>,
  body: Record<string, unknown>,
): Promise<{ response: Response; body: ChannelView }> {
  const response = await app.request("/channels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as ChannelView };
}

describe("POST /channels", () => {
  test("launches an instance and seeds channel_settings with kind defaults", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createChannel(app, {
      kind: "channel",
      name: "General",
    });

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      title: "General",
      kind: "channel",
      pinned: true,
      participants: [],
    });
    expect(typeof body.id).toBe("string");

    const stored = await deps.store.getChannelSettings(TENANT.id, body.id);
    expect(stored?.settings["chat/kind"]).toBe("channel");
    expect(stored?.settings["chat/pinned"]).toBe(true);
  });

  test("an unrecognized kind is accepted as data with chat-like defaults", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");

    const { response, body } = await createChannel(app, { kind: "standup" });

    expect(response.status).toBe(201);
    expect(body.kind).toBe("standup");
    expect(body.pinned).toBe(false);
  });

  test("a malformed body is rejected with the structured error envelope", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "no kind field" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("a denied grant is rejected before any channel is created", async () => {
    const deps = buildDeps({
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response } = await createChannel(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    expect(response.status).toBe(403);
  });

  test("creating a chat without definitionId is a 400", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("creating a chat auto-invites its agent and titles it by handle", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createChannel(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    expect(response.status).toBe(201);
    expect(body.kind).toBe("chat");
    expect(body.title).toBe("echo");
    expect(body.participants).toEqual([
      { address: "ins_invited1@acme.example", handle: "echo" },
    ]);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.launchInviteCalls).toEqual([
      {
        tenantId: TENANT.id,
        creatorPrincipalId: "prn_alice",
        definitionId: "wfd_echo",
      },
    ]);
    expect(platform.replyBridges).toHaveLength(1);
    expect(platform.sentMail).toHaveLength(1);
    const decoded = JSON.parse(
      Buffer.from(
        (platform.sentMail[0]?.content.attachments?.[0]?.data ?? "") as string,
        "base64",
      ).toString("utf-8"),
    ) as { kind: string; event: string };
    expect(decoded.kind).toBe("event");
    expect(decoded.event).toBe("channel.agent-joined");
  });

  test("creating a chat with an explicit name keeps that name as the title", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createChannel(app, {
      kind: "chat",
      name: "My Assistant",
      definitionId: "wfd_echo",
    });

    expect(response.status).toBe(201);
    expect(body.title).toBe("My Assistant");
  });
});

describe("GET /channels", () => {
  test("filters by kind", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    await createChannel(app, { kind: "channel", name: "Durable" });
    await createChannel(app, { kind: "chat", name: "Throwaway" });

    const response = await app.request("/channels?kind=channel");
    const body = (await response.json()) as { items: { title: string }[] };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.title).toBe("Durable");
  });
});

describe("messages", () => {
  test("POST encodes Part[] via the codec and sends as the calling principal", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "chat" });

    const parts: Part[] = [{ kind: "text", text: "hello" }];
    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parts),
    });

    expect(response.status).toBe(201);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(1);
    expect(platform.sentMail[0]?.principalId).toBe("prn_alice");
    expect(platform.sentMail[0]?.content).toEqual({ content: "hello" });
  });

  test("fan-out copies to mentioned agents are sent from the channel", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      name: "demo",
      participants: ["ins_echo1@acme.example"],
    });

    const parts: Part[] = [{ kind: "text", text: "hi @ins_echo1" }];
    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parts),
    });

    expect(response.status).toBe(201);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(2);
    const copy = platform.sentMail[1];
    expect(copy?.channelId).toBe("ins_echo1");
    expect(copy?.fromChannelId).toBe(channel.id);
  });

  test("a message to a chat delivers to its agent without a mention", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const mailBefore = platform.sentMail.length; // the join event

    const parts: Part[] = [{ kind: "text", text: "hello, no mention here" }];
    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parts),
    });

    expect(response.status).toBe(201);
    expect(platform.sentMail).toHaveLength(mailBefore + 2); // to the chat, then fanned to the agent
    const fanned = platform.sentMail[platform.sentMail.length - 1];
    expect(fanned?.channelId).toBe("ins_invited1");
    expect(fanned?.fromChannelId).toBe(channel.id);
  });

  test("a message to a channel still requires a mention to fan out", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["ins_echo1@acme.example"],
    });

    const parts: Part[] = [{ kind: "text", text: "no mention at all" }];
    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parts),
    });

    expect(response.status).toBe(201);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(1); // only to the channel itself
  });

  test("a mention fan-out carries the prior channel conversation, excluding the just-sent message", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["ins_echo1@acme.example"],
    });

    await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ kind: "text", text: "first message" }]),
    });
    await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ kind: "text", text: "second message" }]),
    });
    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ kind: "text", text: "hi @ins_echo1" }]),
    });
    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const decoded = decodeParts(copy?.content ?? { content: "" });

    expect(decoded).toHaveLength(2);
    const [contextPart, messagePart] = decoded;
    expect(contextPart?.kind).toBe("text");
    expect(messagePart).toEqual({ kind: "text", text: "hi @ins_echo1" });

    const contextText = contextPart?.kind === "text" ? contextPart.text : "";
    expect(contextText).toContain(
      "[Channel context — the most recent messages in this channel",
    );
    expect(contextText.split("\n")).toEqual([
      "[Channel context — the most recent messages in this channel, oldest " +
        "first. The actual message addressed to you follows after this " +
        "block.]",
      "user: first message",
      "user: second message",
    ]);
    expect(contextText).not.toContain("hi @ins_echo1");
  });

  test("no prior messages means no context part at all, copy identical to today", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["ins_echo1@acme.example"],
    });

    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ kind: "text", text: "hi @ins_echo1" }]),
    });
    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    expect(copy?.content).toEqual({
      content: "hi @ins_echo1",
      replyTo: channel.id,
    });
  });

  test("a chat's fan-out carries no context block, even with a full history", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ kind: "text", text: "earlier turn" }]),
    });
    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ kind: "text", text: "hello, no mention here" }]),
    });
    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const fanned = platform.sentMail[platform.sentMail.length - 1];
    expect(fanned?.content).toEqual({
      content: "hello, no mention here",
      replyTo: channel.id,
    });
  });

  test("a timeline load failure does not break the send; it fans out un-situated", async () => {
    const platform = fakePlatform();
    platform.listMail = () => {
      throw new Error("boom: platform unavailable");
    };
    const deps = buildDeps({ platform });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["ins_echo1@acme.example"],
    });

    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ kind: "text", text: "hi @ins_echo1" }]),
    });

    expect(response.status).toBe(201);
    const copy = platform.sentMail[platform.sentMail.length - 1];
    expect(copy?.content).toEqual({
      content: "hi @ins_echo1",
      replyTo: channel.id,
    });
  });

  test("inviting into a chat is rejected with a 409", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    const response = await app.request(`/channels/${channel.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");
  });

  test("inviting an agent arms its reply bridge", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(`/channels/${channel.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(201);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.replyBridges).toHaveLength(1);
    expect(platform.replyBridges[0]?.channelId).toBe(channel.id);
  });

  test("reading a channel re-arms bridges for agent participants", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["ins_echo1@acme.example"],
    });

    const response = await app.request(`/channels/${channel.id}/messages`);
    expect(response.status).toBe(200);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.replyBridges).toHaveLength(1);
    expect(platform.replyBridges[0]?.agentChannelId).toBe("ins_echo1");
  });

  test("POST rejects a malformed message body with the 400 envelope", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "chat" });

    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ kind: "not-a-real-part" }]),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("GET decodes run mail back to Part[]", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "chat" });

    await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ kind: "text", text: "hi there" }]),
    });

    const response = await app.request(`/channels/${channel.id}/messages`);
    const body = (await response.json()) as {
      items: {
        parts: Part[];
        sender: { name: string | null; address: string };
      }[];
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.parts).toEqual([{ kind: "text", text: "hi there" }]);
    expect(body.items[0]?.sender).toEqual({
      name: null,
      address: "prn_alice@acme.example",
    });
  });
});

async function sendText(
  app: Hono<TenantEnv>,
  channelId: string,
  text: string,
): Promise<Response> {
  return app.request(`/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ kind: "text", text }]),
  });
}

describe("chat/contextWindow", () => {
  test("a window of 2 keeps only the last 2 prior messages in the block", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["ins_echo1@acme.example"],
    });
    await app.request(`/channels/${channel.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 2 }),
    });

    await sendText(app, channel.id, "one");
    await sendText(app, channel.id, "two");
    await sendText(app, channel.id, "three");
    await sendText(app, channel.id, "hi @ins_echo1");

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";

    expect(contextText).not.toContain("user: one");
    expect(contextText).toContain("user: two");
    expect(contextText).toContain("user: three");
  });

  test("a window of 0 disables the context block entirely", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["ins_echo1@acme.example"],
    });
    await app.request(`/channels/${channel.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 0 }),
    });

    await sendText(app, channel.id, "one");
    await sendText(app, channel.id, "hi @ins_echo1");

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    expect(copy?.content).toEqual({
      content: "hi @ins_echo1",
      replyTo: channel.id,
    });
  });

  test("an absent setting falls back to the default of 20", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["ins_echo1@acme.example"],
    });

    for (let i = 0; i < 20; i++) {
      await sendText(app, channel.id, `msg-${i}`);
    }
    await sendText(app, channel.id, "hi @ins_echo1");

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";
    expect(contextText).toContain("user: msg-0");
    expect(contextText).toContain("user: msg-19");
  });

  test("an invalid value (negative or non-numeric) falls back to the default", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["ins_echo1@acme.example"],
    });
    await app.request(`/channels/${channel.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": -3 }),
    });

    for (let i = 0; i < 21; i++) {
      await sendText(app, channel.id, `msg-${i}`);
    }
    await sendText(app, channel.id, "hi @ins_echo1");

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";
    // Default window is 20: the oldest of the 21 prior messages (msg-0)
    // falls outside it.
    expect(contextText).not.toContain("user: msg-0\n");
    expect(contextText).toContain("user: msg-1");
    expect(contextText).toContain("user: msg-20");
  });

  test("an oversized value clamps to the maximum of 200", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["ins_echo1@acme.example"],
    });
    await app.request(`/channels/${channel.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 10_000 }),
    });

    for (let i = 0; i < 25; i++) {
      await sendText(app, channel.id, `msg-${i}`);
    }
    await sendText(app, channel.id, "hi @ins_echo1");

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";
    // Clamped to 200, well above the 25 available, so all 25 survive.
    expect(contextText).toContain("user: msg-0");
    expect(contextText).toContain("user: msg-24");
  });

  test("chat/contextWindow round-trips through PATCH /channels/:id/settings", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(`/channels/${channel.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 5 }),
    });
    expect(response.status).toBe(200);

    const stored = await deps.store.getChannelSettings(TENANT.id, channel.id);
    expect(stored?.settings["chat/contextWindow"]).toBe(5);
  });

  test("rejects a non-numeric chat/contextWindow value", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(`/channels/${channel.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": "lots" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("PATCH /channels/:id/settings", () => {
  test("validates chat/* strictly, passes foreign namespaces opaquely, and sends control mail", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(`/channels/${channel.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        "chat/pinned": false,
        "acme-widget/color": "blue",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pinned: boolean;
      settings: Record<string, unknown>;
    };
    expect(body.pinned).toBe(false);
    expect(body.settings["acme-widget/color"]).toBe("blue");

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(1);
  });

  test("rejects an unknown chat/* key strictly", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(`/channels/${channel.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/nonexistent-field": true }),
    });

    expect(response.status).toBe(400);
  });

  test("rejects a wrongly typed chat/* value", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(`/channels/${channel.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/pinned": "not-a-boolean" }),
    });

    expect(response.status).toBe(400);
  });
});

describe("read-state", () => {
  test("is per-caller: two principals see independent cursors", async () => {
    const deps = buildDeps();
    const app = createChatRoutes(deps);
    const appAlice = mountAs(app, "prn_alice");
    const appBob = mountAs(app, "prn_bob");
    const { body: channel } = await createChannel(appAlice, { kind: "chat" });

    await appAlice.request(`/channels/${channel.id}/read-state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lastSeenCreatedAt: "2026-01-01T00:00:00.000Z",
        lastSeenId: "mail_alice",
      }),
    });
    await appBob.request(`/channels/${channel.id}/read-state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lastSeenCreatedAt: "2026-02-02T00:00:00.000Z",
        lastSeenId: "mail_bob",
      }),
    });

    const aliceRead = (await (
      await appAlice.request(`/channels/${channel.id}/read-state`)
    ).json()) as { lastSeenId: string };
    const bobRead = (await (
      await appBob.request(`/channels/${channel.id}/read-state`)
    ).json()) as { lastSeenId: string };

    expect(aliceRead.lastSeenId).toBe("mail_alice");
    expect(bobRead.lastSeenId).toBe("mail_bob");
  });
});

describe("GET /channels/:id/invitable", () => {
  test("lists the platform's invitable definitions", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "echo" }],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(`/channels/${channel.id}/invitable`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { id: string; name: string }[];
    };
    expect(body.items).toEqual([{ id: "wfd_echo", name: "echo" }]);
  });

  test("a denied grant is rejected", async () => {
    const deps = buildDeps({
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/channels/ins_x/invitable`);
    expect(response.status).toBe(403);
  });
});

describe("POST /channels/:id/invite", () => {
  test("launches the definition, appends the participant, and posts a join event", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(`/channels/${channel.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      address: string;
      definitionId: string;
    };
    expect(body).toEqual({
      address: "ins_invited1@acme.example",
      definitionId: "wfd_echo",
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.launchInviteCalls).toEqual([
      {
        tenantId: TENANT.id,
        creatorPrincipalId: "prn_alice",
        definitionId: "wfd_echo",
      },
    ]);

    const settingsRow = await deps.store.getChannelSettings(
      TENANT.id,
      channel.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "ins_invited1@acme.example", handle: "ins_invited1" },
    ]);

    expect(platform.sentMail).toHaveLength(1);
    const sent = platform.sentMail[0];
    expect(sent?.channelId).toBe(channel.id);
    const decoded = JSON.parse(
      Buffer.from(
        (sent?.content.attachments?.[0]?.data ?? "") as string,
        "base64",
      ).toString("utf-8"),
    ) as { kind: string; event: string; data: { address: string } };
    expect(decoded.kind).toBe("event");
    expect(decoded.event).toBe("channel.agent-joined");
    expect(decoded.data.address).toBe("ins_invited1@acme.example");
  });

  test("appends onto an existing participant list rather than replacing it", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["existing@acme.example"],
    });

    await app.request(`/channels/${channel.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const settingsRow = await deps.store.getChannelSettings(
      TENANT.id,
      channel.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "existing@acme.example", handle: "existing" },
      { address: "ins_invited1@acme.example", handle: "ins_invited1" },
    ]);
  });

  test("derives the mention handle from the invited definition's name, de-duplicating within the channel", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      participants: ["echo@acme.example"],
    });

    await app.request(`/channels/${channel.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const settingsRow = await deps.store.getChannelSettings(
      TENANT.id,
      channel.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "echo@acme.example", handle: "echo" },
      { address: "ins_invited1@acme.example", handle: "echo-2" },
    ]);
  });

  test("a malformed body is rejected with the structured error envelope", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(`/channels/${channel.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("a missing channel is a 404", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/channels/ins_missing/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(404);
  });

  test("a denied grant is rejected before any launch is attempted", async () => {
    const platform = fakePlatform();
    const deps = buildDeps({
      platform,
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/channels/ins_x/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(403);
    expect(
      (platform as ReturnType<typeof fakePlatform>).launchInviteCalls,
    ).toHaveLength(0);
  });
});

describe("typing", () => {
  test("is never persisted", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "chat" });

    const response = await app.request(`/channels/${channel.id}/typing`, {
      method: "POST",
    });

    expect(response.status).toBe(202);
    const settingsRow = await deps.store.getChannelSettings(
      TENANT.id,
      channel.id,
    );
    expect(settingsRow?.settings).not.toHaveProperty("chat/typing");
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(0);
  });
});
