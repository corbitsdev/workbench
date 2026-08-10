// Fan-out, context-loading, and join/invite behavior — the surface
// `./channel-service.ts`'s `sendChannelMessage` and `launchAndJoinAgent`
// own — exercised through the HTTP layer. Split out of
// `routes.test.ts` alongside the module itself.
import { describe, expect, test } from "bun:test";
import { createChatRoutes } from "../src/routes";
import { decodeParts } from "../src/codec";
import type { Part } from "../src/parts";
import {
  buildDeps,
  createChannel,
  fakePlatform,
  mountAs,
  TENANT,
} from "./test-support";

describe("message fan-out", () => {
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
      body: JSON.stringify({ parts }),
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
      body: JSON.stringify({ parts }),
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
      body: JSON.stringify({ parts }),
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
      body: JSON.stringify({
        parts: [{ kind: "text", text: "first message" }],
      }),
    });
    await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "second message" }],
      }),
    });
    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "hi @ins_echo1" }],
      }),
    });
    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const decoded = decodeParts(copy?.content ?? { content: "" });

    // Exactly ONE text part: the context is merged into the message's
    // text, never sent as a part of its own — a second part makes the
    // copy multipart MIME, which the agent-side mail parser fails on.
    expect(decoded).toHaveLength(1);
    const [merged] = decoded;
    expect(merged?.kind).toBe("text");
    const mergedText = merged?.kind === "text" ? merged.text : "";
    expect(mergedText.split("\n")).toEqual([
      "[Channel context — the most recent messages in this channel, oldest " +
        "first. The actual message addressed to you follows after this " +
        "block.]",
      "user: first message",
      "user: second message",
      "",
      "hi @ins_echo1",
    ]);
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
      body: JSON.stringify({
        parts: [{ kind: "text", text: "hi @ins_echo1" }],
      }),
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
      body: JSON.stringify({ parts: [{ kind: "text", text: "earlier turn" }] }),
    });
    const response = await app.request(`/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "hello, no mention here" }],
      }),
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
      body: JSON.stringify({
        parts: [{ kind: "text", text: "hi @ins_echo1" }],
      }),
    });

    expect(response.status).toBe(201);
    const copy = platform.sentMail[platform.sentMail.length - 1];
    expect(copy?.content).toEqual({
      content: "hi @ins_echo1",
      replyTo: channel.id,
    });
  });

  test("inviting an agent joins it into the channel and posts the join event", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
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
    // Reply routing for the invited agent is the chat orchestrator's
    // concern now (see `chat-orchestrator.test.ts`), not a bridge this
    // route arms — this route only proves the join event was sent.
    expect(platform.sentMail.some((m) => m.channelId === channel.id)).toBe(
      true,
    );
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
});
