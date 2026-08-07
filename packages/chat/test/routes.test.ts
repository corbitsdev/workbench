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
import type { MailContent } from "../src/codec";

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

function fakePlatform(): ChatPlatform & {
  sentMail: { channelId: string; principalId: string; content: MailContent }[];
} {
  const sentMail: {
    channelId: string;
    principalId: string;
    content: MailContent;
  }[] = [];
  const mailByChannel = new Map<
    string,
    { id: string; createdAt: string; mail: unknown }[]
  >();
  let mailCounter = 0;

  return {
    sentMail,
    async launchChannel() {
      return { instanceId: "launched" };
    },
    async sendMail(input) {
      sentMail.push({
        channelId: input.channelId,
        principalId: input.principalId,
        content: input.content,
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
        },
      });
      mailByChannel.set(input.channelId, list);
      return { id, createdAt };
    },
    async listMail(input) {
      return { items: mailByChannel.get(input.channelId) ?? [] };
    },
    async fetchBlob() {
      return "";
    },
    subscribeToChannel() {
      return () => undefined;
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
    ...overrides,
  };
}

interface ChannelView {
  id: string;
  title: string;
  kind: string;
  pinned: boolean;
  participants: string[];
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

    const { response } = await createChannel(app, { kind: "chat" });

    expect(response.status).toBe(403);
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
      items: { parts: Part[] }[];
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.parts).toEqual([{ kind: "text", text: "hi there" }]);
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
