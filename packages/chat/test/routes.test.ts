// Mounts `createChatRoutes` into a bare `Hono` with fake platform/store
// deps, exercising the route surface itself: request parsing, grant
// checks, and HTTP envelope mapping. Settings-vocabulary behavior lives
// in `channel-settings.test.ts`, fan-out/context/invite behavior in
// `channel-service.test.ts`, and the SSE registry in
// `channel-events.test.ts`.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import type { Part } from "../src/parts";
import { createChatRoutes } from "../src/routes";
import { createInMemoryChannelTenancyStore } from "../src/channel-tenancy";
import { createInMemoryChatStore } from "../src/store";
import {
  buildDeps,
  createChannel,
  fakePlatform,
  mountAs,
  principal,
  TENANT,
} from "./test-support";

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

describe("PATCH /channels/:id/settings — route surface", () => {
  test("a missing channel is a 404", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/channels/ins_missing/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/pinned": true }),
    });

    expect(response.status).toBe(404);
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

describe("channel tenancy", () => {
  test("creating a channel mints a child tenant parented under the bench", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { body } = await createChannel(app, {
      kind: "channel",
      name: "General",
    });

    const view = body as unknown as {
      tenancy: { tenantId: string; parentTenantId: string; slug: string };
      legacy: boolean;
    };
    expect(view.legacy).toBe(false);
    expect(view.tenancy.parentTenantId).toBe(TENANT.id);
    expect(view.tenancy.tenantId).toMatch(/^tnt_/);

    const link = await deps.tenancy.getChannelTenancy(body.id);
    expect(link?.tenantId).toBe(view.tenancy.tenantId);
    expect(link?.parentTenantId).toBe(TENANT.id);
  });

  test("GET /channels annotates every created channel with its tenancy and marks a linkless row legacy", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: created } = await createChannel(app, {
      kind: "channel",
      name: "Tenanted",
    });

    // Simulates a channel that predates the tenancy rollout: a
    // channel_settings row with no channel_tenancy link.
    await deps.store.createChannelSettings({
      tenantId: TENANT.id,
      channelId: "ins_legacy",
      settings: { "chat/kind": "channel", "chat/name": "Legacy" },
      updatedBy: "prn_alice",
    });

    const response = await app.request("/channels");
    const body = (await response.json()) as {
      items: {
        id: string;
        legacy: boolean;
        tenancy: { tenantId: string } | null;
      }[];
    };

    const tenantedRow = body.items.find((item) => item.id === created.id);
    expect(tenantedRow?.legacy).toBe(false);
    expect(tenantedRow?.tenancy).not.toBeNull();

    const legacyRow = body.items.find((item) => item.id === "ins_legacy");
    expect(legacyRow?.legacy).toBe(true);
    expect(legacyRow?.tenancy).toBeNull();
  });

  test("POST /channels/:id/move re-parents the channel's tenancy when the caller manages the destination", async () => {
    const tenancy = createInMemoryChannelTenancyStore();
    tenancy.registerExistingTenant("tnt_new_bench");
    tenancy.grantManageInTenant("prn_alice", "tnt_new_bench");
    const deps = buildDeps({ tenancy });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      name: "Movable",
    });

    const response = await app.request(`/channels/${channel.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newParentTenantId: "tnt_new_bench" }),
    });

    expect(response.status).toBe(200);
    const moved = (await response.json()) as {
      tenancy: { parentTenantId: string };
    };
    expect(moved.tenancy.parentTenantId).toBe("tnt_new_bench");

    const link = await deps.tenancy.getChannelTenancy(channel.id);
    expect(link?.parentTenantId).toBe("tnt_new_bench");
  });

  test("POST /channels/:id/move is refused when the destination tenant does not exist", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      name: "Movable",
    });

    const response = await app.request(`/channels/${channel.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newParentTenantId: "tnt_does_not_exist" }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");

    const link = await deps.tenancy.getChannelTenancy(channel.id);
    expect(link?.parentTenantId).toBe(TENANT.id);
  });

  test("POST /channels/:id/move is refused when the caller has no standing in a real destination tenant", async () => {
    const tenancy = createInMemoryChannelTenancyStore();
    tenancy.registerExistingTenant("tnt_someone_elses_bench");
    const deps = buildDeps({ tenancy });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      name: "Movable",
    });

    const response = await app.request(`/channels/${channel.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newParentTenantId: "tnt_someone_elses_bench" }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");

    const link = await deps.tenancy.getChannelTenancy(channel.id);
    expect(link?.parentTenantId).toBe(TENANT.id);
  });

  test("POST /channels/:id/move on a legacy channel is a loud 409, never a silent no-op", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    await deps.store.createChannelSettings({
      tenantId: TENANT.id,
      channelId: "ins_legacy",
      settings: { "chat/kind": "channel" },
      updatedBy: "prn_alice",
    });

    const response = await app.request(`/channels/ins_legacy/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newParentTenantId: "tnt_new_bench" }),
    });

    expect(response.status).toBe(409);
  });

  test("a bench never sees another bench's channel tenancies", async () => {
    const OTHER_TENANT = { ...TENANT, id: "tnt_2", domain: "other.example" };
    const store = createInMemoryChatStore();
    const tenancy = createInMemoryChannelTenancyStore();
    const deps = buildDeps({ store, tenancy });
    const routes = createChatRoutes(deps);

    const appBenchA = mountAs(routes, "prn_alice");
    await createChannel(appBenchA, { kind: "channel", name: "Bench A Only" });

    const appBenchB = new Hono<TenantEnv>();
    appBenchB.use("*", async (c, next) => {
      c.set("tenant", OTHER_TENANT);
      c.set("principal", principal("prn_bob"));
      await next();
    });
    appBenchB.route("/", routes);
    const { body: benchBChannel } = await createChannel(appBenchB, {
      kind: "channel",
      name: "Bench B Only",
    });

    const listA = (await (await appBenchA.request("/channels")).json()) as {
      items: { id: string; title: string }[];
    };
    expect(listA.items.map((item) => item.title)).toEqual(["Bench A Only"]);
    expect(listA.items.map((item) => item.id)).not.toContain(benchBChannel.id);

    const listB = (await (await appBenchB.request("/channels")).json()) as {
      items: { id: string; title: string }[];
    };
    expect(listB.items.map((item) => item.title)).toEqual(["Bench B Only"]);

    const tenancyA = await tenancy.listChildChannelTenancies(TENANT.id);
    const tenancyB = await tenancy.listChildChannelTenancies(OTHER_TENANT.id);
    expect(tenancyA).toHaveLength(1);
    expect(tenancyB).toHaveLength(1);
    expect(tenancyA[0]?.tenantId).not.toBe(tenancyB[0]?.tenantId);
  });
});
