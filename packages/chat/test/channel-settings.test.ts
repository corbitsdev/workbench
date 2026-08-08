// Settings-vocabulary behavior exercised through the HTTP surface:
// `chat/contextWindow` reading/clamping (`contextWindowOf`) and PATCH
// validation (`validateSettingsPatch`). Split out of `routes.test.ts`
// alongside `./channel-settings.ts` itself.
import { describe, expect, test } from "bun:test";
import { createChatRoutes } from "../src/routes";
import { decodeParts } from "../src/codec";
import {
  buildDeps,
  createChannel,
  mountAs,
  sendText,
  TENANT,
} from "./test-support";
import type { fakePlatform } from "./test-support";

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
