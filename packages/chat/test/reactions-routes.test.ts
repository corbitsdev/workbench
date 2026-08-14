// HTTP surface for message reactions: membership gating, curated-emoji
// validation, true toggle semantics over HTTP, tenant isolation, the
// batched `reactions` field on `GET /messages`, and the `chat.reaction`
// SSE event.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import { createInMemoryReactionStore } from "../src/reactions";
import { createChannelSubscriberRegistry } from "../src/channel-events";
import type { ChatChannelEvent } from "../src/platform-port";
import { buildDeps, createChannel, mountAs, sendText } from "./test-support";

function toggleUrl(channelId: string, messageId: string) {
  return `/channels/${channelId}/messages/${messageId}/reactions/toggle`;
}

async function toggle(
  app: ReturnType<typeof mountAs>,
  channelId: string,
  messageId: string,
  emoji: string,
) {
  return app.request(toggleUrl(channelId, messageId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emoji }),
  });
}

describe("reaction routes — gating", () => {
  test("no reactions store injected: toggle 404s, never silently no-ops", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await toggle(app, channel.id, "m1", "👍");
    expect(response.status).toBe(404);
  });

  test("a denied grant is rejected before any reaction is stored", async () => {
    const store = createInMemoryReactionStore();
    const deps = buildDeps({
      reactions: store,
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const channelId = "run_channel1";

    const response = await toggle(app, channelId, "m1", "👍");
    expect(response.status).toBe(403);
    expect(
      await store.listReactionsForMessages("tnt_1", channelId, ["m1"]),
    ).toHaveLength(0);
  });

  test("an unknown channel id 404s rather than accepting a reaction into nowhere", async () => {
    const deps = buildDeps({ reactions: createInMemoryReactionStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await toggle(app, "run_ghost", "m1", "👍");
    expect(response.status).toBe(404);
  });

  test("a channel that belongs to a different tenant is invisible: 404, not leaked cross-tenant", async () => {
    const store = createInMemoryReactionStore();
    const deps = buildDeps({ reactions: store });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body } = await createChannel(app, { kind: "channel" });

    const otherDeps = buildDeps({ reactions: store });
    const otherApp = mountAs(createChatRoutes(otherDeps), "prn_mallory");

    const response = await toggle(otherApp, body.id, "m1", "👍");
    expect(response.status).toBe(404);
  });

  test("an emoji outside the curated set is rejected", async () => {
    const deps = buildDeps({ reactions: createInMemoryReactionStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const response = await toggle(app, channel.id, "m1", "🐙");
    expect(response.status).toBe(400);
  });
});

describe("reaction routes — toggle semantics", () => {
  test("toggling adds, toggling again removes — reported over HTTP", async () => {
    const deps = buildDeps({ reactions: createInMemoryReactionStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const first = await toggle(app, channel.id, "m1", "👍");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      emoji: string;
      count: number;
      reactedByMe: boolean;
    };
    expect(firstBody).toEqual({ emoji: "👍", count: 1, reactedByMe: true });

    const second = await toggle(app, channel.id, "m1", "👍");
    const secondBody = (await second.json()) as {
      emoji: string;
      count: number;
      reactedByMe: boolean;
    };
    expect(secondBody).toEqual({ emoji: "👍", count: 0, reactedByMe: false });
  });

  test("two principals reacting with the same emoji both count", async () => {
    const store = createInMemoryReactionStore();
    const deps = buildDeps({ reactions: store });
    const appAlice = mountAs(createChatRoutes(deps), "prn_alice");
    const appBob = mountAs(createChatRoutes(deps), "prn_bob");
    const { body: channel } = await createChannel(appAlice, {
      kind: "channel",
    });

    await toggle(appAlice, channel.id, "m1", "🎉");
    const bobResult = await toggle(appBob, channel.id, "m1", "🎉");
    const bobBody = (await bobResult.json()) as { count: number };
    expect(bobBody.count).toBe(2);
  });
});

describe("reaction routes — the message wire type carries reactions", () => {
  test("GET /messages attaches a batched reactions summary onto each item", async () => {
    const deps = buildDeps({ reactions: createInMemoryReactionStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });
    await sendText(app, channel.id, "hello");

    const list = await app.request(`/channels/${channel.id}/messages`);
    const before = (await list.json()) as {
      items: { id: string; reactions?: unknown[] }[];
    };
    const messageId = before.items[0]?.id;
    expect(messageId).toBeDefined();
    expect(before.items[0]?.reactions).toEqual([]);

    await toggle(app, channel.id, messageId as string, "👀");

    const after = await app.request(`/channels/${channel.id}/messages`);
    const afterBody = (await after.json()) as {
      items: {
        id: string;
        reactions?: { emoji: string; count: number; reactedByMe: boolean }[];
      }[];
    };
    expect(afterBody.items[0]?.reactions).toEqual([
      { emoji: "👀", count: 1, reactedByMe: true },
    ]);
  });

  test("without a reactions store, the reactions field is simply absent", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });
    await sendText(app, channel.id, "hello");

    const list = await app.request(`/channels/${channel.id}/messages`);
    const body = (await list.json()) as { items: Record<string, unknown>[] };
    expect(body.items[0]).not.toHaveProperty("reactions");
  });
});

describe("reaction routes — chat.reaction SSE event", () => {
  test("a toggle publishes onto the channel's subscriber registry, live", async () => {
    const channelSubscribers = createChannelSubscriberRegistry();
    const deps = buildDeps({
      reactions: createInMemoryReactionStore(),
      channelSubscribers,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const received: ChatChannelEvent[] = [];
    channelSubscribers.subscribe(channel.id, (event) => received.push(event));

    await toggle(app, channel.id, "m1", "🚀");

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "chat.reaction",
      data: { messageId: "m1", emoji: "🚀", added: true },
    });
  });
});
