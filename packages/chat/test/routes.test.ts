// Mounts `createChatRoutes` into a bare `Hono` with fake platform/store
// deps, exercising the route surface itself: request parsing, grant
// checks, and HTTP envelope mapping. Settings-vocabulary behavior lives
// in `channel-settings.test.ts`, fan-out/context/invite behavior in
// `channel-service.test.ts`, and the SSE registry in
// `channel-events.test.ts`.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { InferenceResolutionError } from "@corbits/folded-runs";
import type { Part } from "../src/parts";
import { createChatRoutes } from "../src/routes";
import { createInMemoryChannelTenancyStore } from "../src/channel-tenancy";
import { createInMemoryChatStore } from "../src/store";
import { createInMemoryThreadStore } from "../src/threads";
import {
  buildDeps,
  createChannel,
  fakePlatform,
  mountAs,
  principal,
  sendText,
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

  test("creating an unnamed chat titles it by the agent's display name, tenant row included", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_assist", name: "assistant", description: "Myra" },
        ],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createChannel(app, {
      kind: "chat",
      definitionId: "wfd_assist",
    });

    expect(response.status).toBe(201);
    expect(body.title).toBe("Myra");
    expect(body.participants).toEqual([
      { address: "ins_invited1@acme.example", handle: "assistant" },
    ]);
    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryChannelTenancyStore
    >;
    const [minted] = await tenancy.listChildChannelTenancies(TENANT.id);
    expect(minted?.slug.startsWith("myra")).toBe(true);
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

  test("creating a chat whose agent has no launchable inference source returns 409, not 500", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
        launchInvite: async () => {
          throw new InferenceResolutionError(
            "the invited agent",
            "This definition declares no model requirements",
          );
        },
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(409);
    const errorBody = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(errorBody.error.code).toBe("not_launchable");
    expect(errorBody.error.message).toBe(
      "This definition declares no model requirements",
    );
  });

  test("agent launch failure returns 422, not 500, and compensates the channel", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
        launchInvite: () =>
          Promise.reject(new Error("blocked: too many @mentions; max 5")),
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("agent_launch_failed");
    expect(body.error.message).toContain("too many @mentions");

    // The half-built channel is rolled back: its settings row is gone
    // and its minted tenant is compensated, so a retry starts clean.
    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryChannelTenancyStore
    >;
    const channels = await deps.store.listChannelSettings(TENANT.id);
    expect(channels).toHaveLength(0);
    expect(await tenancy.listChildChannelTenancies(TENANT.id)).toHaveLength(0);
  });
});

describe("POST /channels — chat with a person (DM)", () => {
  function registerBob(deps: ReturnType<typeof buildDeps>) {
    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryChannelTenancyStore
    >;
    tenancy.registerPrincipal(TENANT.id, {
      id: "prn_bob",
      kind: "user",
      status: "active",
    });
  }

  test("creates a two-member chat carrying the person as its participant", async () => {
    const deps = buildDeps();
    registerBob(deps);
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createChannel(app, {
      kind: "chat",
      principalId: "prn_bob",
      name: "Bob",
    });

    expect(response.status).toBe(201);
    expect(body.kind).toBe("chat");
    expect(body.title).toBe("Bob");
    expect(body.participants).toEqual([{ address: "prn_bob", handle: "bob" }]);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.launchInviteCalls).toHaveLength(0);
    expect(platform.sentMail).toHaveLength(1);
    const decoded = JSON.parse(
      Buffer.from(
        (platform.sentMail[0]?.content.attachments?.[0]?.data ?? "") as string,
        "base64",
      ).toString("utf-8"),
    ) as { kind: string; event: string };
    expect(decoded.kind).toBe("event");
    expect(decoded.event).toBe("channel.member-joined");
  });

  test("falls back to the bare principal id as both handle and title when no name is given — the defensive edge case a bare API call can hit; chat-ui always sends the member's display name as `name` instead", async () => {
    const deps = buildDeps();
    registerBob(deps);
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createChannel(app, {
      kind: "chat",
      principalId: "prn_bob",
    });

    expect(response.status).toBe(201);
    expect(body.title).toBe("prn_bob");
    expect(body.participants).toEqual([
      { address: "prn_bob", handle: "prn_bob" },
    ]);
  });

  test("rejects a chat with both a definitionId and a principalId", async () => {
    const deps = buildDeps();
    registerBob(deps);
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "chat",
        definitionId: "wfd_echo",
        principalId: "prn_bob",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("refuses to start a direct chat with yourself — 409", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", principalId: "prn_alice" }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");

    // Nothing was minted for a request refused before creation began.
    const channels = await deps.store.listChannelSettings(TENANT.id);
    expect(channels).toHaveLength(0);
  });

  test("rejects a principalId naming no active member of this bench — 400", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", principalId: "prn_ghost" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");

    const channels = await deps.store.listChannelSettings(TENANT.id);
    expect(channels).toHaveLength(0);
  });

  test("rejects a principalId naming a suspended member — 400", async () => {
    const deps = buildDeps();
    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryChannelTenancyStore
    >;
    tenancy.registerPrincipal(TENANT.id, {
      id: "prn_bob",
      kind: "user",
      status: "suspended",
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", principalId: "prn_bob" }),
    });

    expect(response.status).toBe(400);
  });
});

describe("POST /channels/:id/invite", () => {
  test("an agent with no launchable inference source returns 409, not 500", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        launchInvite: async () => {
          throw new InferenceResolutionError(
            "the invited agent",
            "No launchable inference source for that definition",
          );
        },
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    // Invite is for channels only; create one first.
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      name: "Test Channel",
    });
    expect(channel.id).toBeTruthy();

    const response = await app.request(`/channels/${channel.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_new" }),
    });

    expect(response.status).toBe(409);
    const errorBody = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(errorBody.error.code).toBe("not_launchable");
    expect(errorBody.error.message).toBe(
      "No launchable inference source for that definition",
    );
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

  test("a channel with no messages reports unreadCount 0 and no lastActivityAt", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    await createChannel(app, { kind: "channel", name: "Quiet" });

    const response = await app.request("/channels?kind=channel");
    const body = (await response.json()) as {
      items: {
        unreadCount?: number;
        lastActivityAt?: string;
        live?: boolean;
      }[];
    };

    expect(body.items[0]?.unreadCount).toBe(0);
    expect(body.items[0]?.lastActivityAt).toBeUndefined();
    expect(body.items[0]?.live).toBeUndefined();
  });

  test("counts messages sent since the caller's own read cursor as unread", async () => {
    const deps = buildDeps();
    const app = createChatRoutes(deps);
    const appAlice = mountAs(app, "prn_alice");
    const appBob = mountAs(app, "prn_bob");
    const { body: channel } = await createChannel(appAlice, {
      kind: "channel",
      name: "General",
    });

    await sendText(appAlice, channel.id, "hello");
    await sendText(appAlice, channel.id, "world");

    const bobList = (await (
      await appBob.request("/channels?kind=channel")
    ).json()) as {
      items: {
        id: string;
        unreadCount?: number;
        lastActivityAt?: string;
        live?: boolean;
      }[];
    };
    const bobRow = bobList.items.find((item) => item.id === channel.id);
    expect(bobRow?.unreadCount).toBe(2);
    expect(bobRow?.lastActivityAt).toBeDefined();
    expect(bobRow?.live).toBe(true);
  });

  test("the unread badge clears once the caller's read cursor catches up", async () => {
    const deps = buildDeps();
    const app = createChatRoutes(deps);
    const appAlice = mountAs(app, "prn_alice");
    const appBob = mountAs(app, "prn_bob");
    const { body: channel } = await createChannel(appAlice, {
      kind: "channel",
      name: "General",
    });

    await sendText(appAlice, channel.id, "hello");
    const sent = (await (
      await appAlice.request(`/channels/${channel.id}/messages`)
    ).json()) as { items: { id: string; createdAt: string }[] };
    const last = sent.items.at(-1);
    if (last === undefined) throw new Error("expected at least one message");

    await appBob.request(`/channels/${channel.id}/read-state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lastSeenCreatedAt: last.createdAt,
        lastSeenId: last.id,
      }),
    });

    const bobList = (await (
      await appBob.request("/channels?kind=channel")
    ).json()) as { items: { id: string; unreadCount?: number }[] };
    const bobRow = bobList.items.find((item) => item.id === channel.id);
    expect(bobRow?.unreadCount).toBe(0);
  });
});

describe("messages", () => {
  test("POST encodes Part[] via the codec and sends as the calling principal", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const parts: Part[] = [{ kind: "text", text: "hello" }];
    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts }),
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
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "not-a-real-part" }] }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("GET decodes run mail back to Part[]", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "hi there" }] }),
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

describe("GET /channels/:id/blobs/:blobId", () => {
  test("returns the platform's blob bytes base64-encoded", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        fetchBlob: async () => "hello attachment",
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(
      `/channels/${channel.id}/blobs/blob_mail1_1`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { contentBase64: string };
    expect(Buffer.from(body.contentBase64, "base64").toString("utf-8")).toBe(
      "hello attachment",
    );
  });

  test("404s for a channel outside the tenant", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/channels/no-such-channel/blobs/x");

    expect(response.status).toBe(404);
  });

  test("404s when the platform can't resolve the blob", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        fetchBlob: async () => {
          throw new Error("no such blob");
        },
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await app.request(
      `/channels/${channel.id}/blobs/blob_missing_1`,
    );

    expect(response.status).toBe(404);
  });
});

describe("threads — root feed vs reply membership (4a)", () => {
  test("root-thread messages exclude reply-thread posts; open reply still works", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const rootPost = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "root note" }] }),
    });
    expect(rootPost.status).toBe(201);
    const rootSent = (await rootPost.json()) as {
      id: string;
      threadId: string;
    };

    const replyPost = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "reply note" }],
        inReplyToMessageId: rootSent.id,
      }),
    });
    expect(replyPost.status).toBe(201);
    const replySent = (await replyPost.json()) as {
      id: string;
      threadId: string;
    };
    expect(replySent.threadId).not.toBe(rootSent.threadId);

    // Full mailbox still lists both (platform mail is unfiltered).
    const allMail = await app.request(`/channels/${channel.id}/messages`);
    const allBody = (await allMail.json()) as { items: { id: string }[] };
    expect(allBody.items.map((i) => i.id).sort()).toEqual(
      [rootSent.id, replySent.id].sort(),
    );

    // Root-thread feed is root membership only.
    const rootFeed = await app.request(
      `/channels/${channel.id}/threads/${rootSent.threadId}/messages`,
    );
    expect(rootFeed.status).toBe(200);
    const rootBody = (await rootFeed.json()) as {
      items: { id: string; parts: Part[] }[];
    };
    expect(rootBody.items.map((i) => i.id)).toEqual([rootSent.id]);
    expect(rootBody.items[0]?.parts).toEqual([
      { kind: "text", text: "root note" },
    ]);

    // Open-thread view still returns reply-thread membership.
    const replyFeed = await app.request(
      `/channels/${channel.id}/threads/${replySent.threadId}/messages`,
    );
    expect(replyFeed.status).toBe(200);
    const replyBody = (await replyFeed.json()) as {
      items: { id: string; parts: Part[] }[];
    };
    expect(replyBody.items.map((i) => i.id)).toEqual([replySent.id]);
    expect(replyBody.items[0]?.parts).toEqual([
      { kind: "text", text: "reply note" },
    ]);

    // listThreads exposes rootThreadId for the client root feed.
    const threadsRes = await app.request(`/channels/${channel.id}/threads`);
    expect(threadsRes.status).toBe(200);
    const threadsBody = (await threadsRes.json()) as {
      rootThreadId: string;
      items: { id: string; kind: string }[];
    };
    expect(threadsBody.rootThreadId).toBe(rootSent.threadId);
    expect(
      threadsBody.items.some(
        (t) => t.id === replySent.threadId && t.kind === "reply",
      ),
    ).toBe(true);
  });
});

describe("POST /channels/:id/threads/fork — two-level cap (CL-5908, CL-5948)", () => {
  test("forking a message inside a thread opens a depth-2 sub-thread, carrying the origin message id", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const rootPost = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "root note" }] }),
    });
    const rootSent = (await rootPost.json()) as { id: string };

    const replyPost = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "in the thread" }],
        inReplyToMessageId: rootSent.id,
      }),
    });
    const replySent = (await replyPost.json()) as {
      id: string;
      threadId: string;
    };

    const forkRes = await app.request(`/channels/${channel.id}/threads/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentMessageId: replySent.id }),
    });
    expect(forkRes.status).toBe(201);
    const forked = (await forkRes.json()) as {
      id: string;
      kind: string;
      parentMessageId: string;
      parentThreadId: string;
    };
    expect(forked.kind).toBe("reply");
    expect(forked.parentMessageId).toBe(replySent.id);
    expect(forked.parentThreadId).toBe(replySent.threadId);
  });

  test("forking a message already inside a sub-thread creates a sibling under the same parent, never a third level", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const rootSent = (await (
      await app.request(`/channels/${channel.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text: "root" }] }),
      })
    ).json()) as { id: string };

    const threadSent = (await (
      await app.request(`/channels/${channel.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "in thread" }],
          inReplyToMessageId: rootSent.id,
        }),
      })
    ).json()) as { id: string; threadId: string };

    const subThreadFork = (await (
      await app.request(`/channels/${channel.id}/threads/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentMessageId: threadSent.id }),
      })
    ).json()) as { id: string; parentThreadId: string };

    // Post a message into the sub-thread, then fork *that* message.
    const subMessageSent = (await (
      await app.request(`/channels/${channel.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "inside the sub-thread" }],
          threadId: subThreadFork.id,
        }),
      })
    ).json()) as { id: string };

    const siblingRes = await app.request(
      `/channels/${channel.id}/threads/fork`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentMessageId: subMessageSent.id }),
      },
    );
    expect(siblingRes.status).toBe(201);
    const sibling = (await siblingRes.json()) as {
      id: string;
      parentThreadId: string;
    };
    expect(sibling.id).not.toBe(subThreadFork.id);
    // Sibling hangs off the same depth-1 parent as the sub-thread it was
    // forked from — never a third level.
    expect(sibling.parentThreadId).toBe(subThreadFork.parentThreadId);
    expect(sibling.parentThreadId).toBe(threadSent.threadId);
  });

  test("replying (not forking) to a message already in a sub-thread is an honest 409, not silent third-level nesting", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const rootSent = (await (
      await app.request(`/channels/${channel.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text: "root" }] }),
      })
    ).json()) as { id: string };

    const threadSent = (await (
      await app.request(`/channels/${channel.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "in thread" }],
          inReplyToMessageId: rootSent.id,
        }),
      })
    ).json()) as { id: string };

    const subThreadFork = (await (
      await app.request(`/channels/${channel.id}/threads/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentMessageId: threadSent.id }),
      })
    ).json()) as { id: string };

    const subMessageSent = (await (
      await app.request(`/channels/${channel.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "inside the sub-thread" }],
          threadId: subThreadFork.id,
        }),
      })
    ).json()) as { id: string };

    const blockedRes = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "trying a third level" }],
        inReplyToMessageId: subMessageSent.id,
      }),
    });
    expect(blockedRes.status).toBe(409);
    const blockedBody = (await blockedRes.json()) as {
      error: { code: string };
    };
    expect(blockedBody.error.code).toBe("conflict");
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
    const { body: channel } = await createChannel(appAlice, {
      kind: "channel",
    });

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

  test("a nonexistent channel 404s", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "echo" }],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/channels/ins_missing/invitable`);
    expect(response.status).toBe(404);
  });
});

describe("GET /invitable-definitions", () => {
  test("lists the tenant's invitable definitions with no channel required", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "echo" }],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/invitable-definitions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { id: string; name: string }[];
    };
    expect(body.items).toEqual([{ id: "wfd_echo", name: "echo" }]);
  });

  test("the host's isInvitableDefinition predicate prunes automations", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_assistant", name: "assistant", description: "Myra" },
          { id: "wfd_digest", name: "channel-digest" },
        ],
      }),
      isInvitableDefinition: (definition) =>
        definition.name !== "channel-digest",
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/invitable-definitions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { id: string; name: string; description?: string }[];
    };
    expect(body.items).toEqual([
      { id: "wfd_assistant", name: "assistant", description: "Myra" },
    ]);
  });

  test("a denied grant is rejected", async () => {
    const deps = buildDeps({
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/invitable-definitions`);
    expect(response.status).toBe(403);
  });
});

describe("typing", () => {
  test("is never persisted", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

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

  test("a compensation failure after a launch failure still surfaces the original launch error, never the compensation's", async () => {
    const tenancy = createInMemoryChannelTenancyStore();
    const uncompensatableTenancy = {
      ...tenancy,
      async compensateChannelTenant(): Promise<void> {
        throw new Error("compensation storage unavailable");
      },
    };
    const platform = fakePlatform({
      launchChannel: async () => {
        throw new Error("channel host launch failed");
      },
    });
    const deps = buildDeps({ tenancy: uncompensatableTenancy, platform });
    const routes = createChatRoutes(deps);
    // Hono's default error handling swallows a thrown error into a
    // generic 500 body, which is useless for telling "the original
    // error propagated" apart from "the compensation error masked it"
    // — both look identical over HTTP. `onError` intercepts the actual
    // thrown value before Hono discards it, so the assertion below
    // can inspect the real error rather than its flattened response.
    let caught: unknown;
    routes.onError((err) => {
      caught = err;
      return new Response(null, { status: 500 });
    });
    const app = mountAs(routes, "prn_alice");

    // Both the launch and its compensation fail. The double failure
    // must never produce a silently swallowed error: the route
    // re-throws the ORIGINAL launch error, not the compensation
    // failure that masked it in the bug this test guards against.
    const response = await app.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "channel", name: "Doomed" }),
    });

    expect(response.status).toBe(500);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("channel host launch failed");

    // The tenant this mint created is now an orphan the compensation
    // could not clean up — that is the accepted, loudly-logged
    // consequence of a double failure, not something this test can
    // observe through the in-memory store (which has no "orphaned
    // tenants" ledger), but the channel itself must never have been
    // recorded as ready to use.
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

  test("GET /channels still reports a moved channel's current tenancy from the bench it was created in", async () => {
    // A channel's channel_settings row stays keyed to the bench it was
    // created in forever — a move only ever changes the tenancy link's
    // parent, never that row. The regression this guards against: GET
    // /channels used to look up tenancy links by "children of this
    // bench", which goes stale the moment a channel moves elsewhere,
    // so the creating bench reported the moved channel as `legacy`
    // with a null tenancy instead of its real, current parent.
    const tenancy = createInMemoryChannelTenancyStore();
    tenancy.registerExistingTenant("tnt_new_bench");
    tenancy.grantManageInTenant("prn_alice", "tnt_new_bench");
    const deps = buildDeps({ tenancy });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      name: "Movable",
    });

    const moveResponse = await app.request(`/channels/${channel.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newParentTenantId: "tnt_new_bench" }),
    });
    expect(moveResponse.status).toBe(200);

    const listResponse = await app.request("/channels");
    const body = (await listResponse.json()) as {
      items: {
        id: string;
        legacy: boolean;
        tenancy: { parentTenantId: string } | null;
      }[];
    };
    const row = body.items.find((item) => item.id === channel.id);
    expect(row?.legacy).toBe(false);
    expect(row?.tenancy?.parentTenantId).toBe("tnt_new_bench");
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

  test("POST /channels/:id/move is refused when the destination would make the channel its own ancestor", async () => {
    const tenancy = createInMemoryChannelTenancyStore();
    const deps = buildDeps({ tenancy });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, {
      kind: "channel",
      name: "Movable",
    });
    const link = await deps.tenancy.getChannelTenancy(channel.id);
    if (link === undefined) throw new Error("expected a tenancy link");
    // The caller manages its own channel's tenant (seeded as owner at
    // creation) — proving this rejection is structural, not
    // authorization: full grants and it is still refused.
    tenancy.grantManageInTenant("prn_alice", link.tenantId);

    const response = await app.request(`/channels/${channel.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newParentTenantId: link.tenantId }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");

    const unchanged = await deps.tenancy.getChannelTenancy(channel.id);
    expect(unchanged?.parentTenantId).toBe(TENANT.id);
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

describe("cross-tenant channel isolation", () => {
  function mountTenant(
    routes: ReturnType<typeof createChatRoutes>,
    tenant: typeof TENANT,
    principalId: string,
  ) {
    const app = new Hono<TenantEnv>();
    app.use("*", async (c, next) => {
      c.set("tenant", tenant);
      c.set("principal", principal(principalId));
      await next();
    });
    app.route("/", routes);
    return app;
  }

  test("POST/GET messages reject a channel owned by another tenant", async () => {
    const OTHER_TENANT = { ...TENANT, id: "tnt_2", domain: "other.example" };
    const deps = buildDeps();
    const routes = createChatRoutes(deps);
    const appA = mountTenant(routes, TENANT, "prn_alice");
    const appB = mountTenant(routes, OTHER_TENANT, "prn_bob");

    const { body: channel } = await createChannel(appA, { kind: "channel" });

    const postB = await appB.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "cross-tenant write" }],
      }),
    });
    expect(postB.status).toBe(404);
    expect(
      (deps.platform as ReturnType<typeof fakePlatform>).sentMail,
    ).toHaveLength(0);

    const getB = await appB.request(`/channels/${channel.id}/messages`);
    expect(getB.status).toBe(404);
  });

  test("typing and stream reject a channel owned by another tenant", async () => {
    const OTHER_TENANT = { ...TENANT, id: "tnt_2", domain: "other.example" };
    const deps = buildDeps();
    const routes = createChatRoutes(deps);
    const appA = mountTenant(routes, TENANT, "prn_alice");
    const appB = mountTenant(routes, OTHER_TENANT, "prn_bob");

    const { body: channel } = await createChannel(appA, { kind: "channel" });

    const typing = await appB.request(`/channels/${channel.id}/typing`, {
      method: "POST",
    });
    expect(typing.status).toBe(404);

    const stream = await appB.request(`/channels/${channel.id}/stream`);
    expect(stream.status).toBe(404);
  });

  test("read-state and invitable reject a channel owned by another tenant", async () => {
    const OTHER_TENANT = { ...TENANT, id: "tnt_2", domain: "other.example" };
    const deps = buildDeps();
    const routes = createChatRoutes(deps);
    const appA = mountTenant(routes, TENANT, "prn_alice");
    const appB = mountTenant(routes, OTHER_TENANT, "prn_bob");

    const { body: channel } = await createChannel(appA, { kind: "channel" });

    const readGet = await appB.request(`/channels/${channel.id}/read-state`);
    expect(readGet.status).toBe(404);

    const readPut = await appB.request(`/channels/${channel.id}/read-state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lastSeenCreatedAt: "2026-01-01T00:00:00.000Z",
        lastSeenId: "mail_x",
      }),
    });
    expect(readPut.status).toBe(404);

    const invitable = await appB.request(`/channels/${channel.id}/invitable`);
    expect(invitable.status).toBe(404);
  });

  test("GET messages allows a launched agent instance in the same tenant", async () => {
    // Agent mailboxes are instance ids with a channel_launch row, not a
    // channel_settings row. The tenancy gate must accept those so the
    // e2e "invite agent → list its messages" path keeps working.
    const baseStore = createInMemoryChatStore();
    const launchedKeys = new Set<string>();
    const gatedStore = {
      ...baseStore,
      hasLaunchedInstance: async (tenantId: string, instanceId: string) =>
        launchedKeys.has(`${tenantId}:${instanceId}`) ||
        baseStore.hasLaunchedInstance(tenantId, instanceId),
    };
    const deps = buildDeps({ store: gatedStore });
    const routes = createChatRoutes(deps);
    const app = mountTenant(routes, TENANT, "prn_alice");

    launchedKeys.add(`${TENANT.id}:ins_agent_mailbox`);
    const res = await app.request(`/channels/ins_agent_mailbox/messages`);
    expect(res.status).toBe(200);

    // Foreign tenant still 404s even with the same instance id shape.
    const other = mountTenant(
      routes,
      { ...TENANT, id: "tnt_2", domain: "other.example" },
      "prn_bob",
    );
    const denied = await other.request(`/channels/ins_agent_mailbox/messages`);
    expect(denied.status).toBe(404);
  });
});
