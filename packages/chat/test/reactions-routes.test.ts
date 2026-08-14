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

/** Sends a real message and returns its id — every toggle test below
 * that expects a 200/400 round trip (rather than a gating 403/404 that
 * never reaches the message-existence check) needs a message that
 * actually exists, now that toggling against an unknown id 404s. */
async function sendAndGetMessageId(
  app: ReturnType<typeof mountAs>,
  channelId: string,
): Promise<string> {
  await sendText(app, channelId, "hello");
  const list = await app.request(`/channels/${channelId}/messages`);
  const body = (await list.json()) as { items: { id: string }[] };
  const id = body.items[0]?.id;
  if (id === undefined) throw new Error("sendAndGetMessageId: no message id");
  return id;
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
    const messageId = await sendAndGetMessageId(app, channel.id);

    const response = await toggle(app, channel.id, messageId, "🐙");
    expect(response.status).toBe(400);
  });

  test("a messageId that was never sent 404s rather than writing an orphaned reaction row", async () => {
    const store = createInMemoryReactionStore();
    const deps = buildDeps({ reactions: store });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });
    // A real message exists in the channel, but "m_ghost" is not it —
    // proves the check resolves the specific id, not just "some
    // message exists in this channel".
    await sendText(app, channel.id, "unrelated message");

    const response = await toggle(app, channel.id, "m_ghost", "👍");
    expect(response.status).toBe(404);
    expect(
      await store.listReactionsForMessages("tnt_1", channel.id, ["m_ghost"]),
    ).toHaveLength(0);
  });
});

describe("reaction routes — toggle semantics", () => {
  test("toggling adds, toggling again removes — reported over HTTP", async () => {
    const deps = buildDeps({ reactions: createInMemoryReactionStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });
    const messageId = await sendAndGetMessageId(app, channel.id);

    const first = await toggle(app, channel.id, messageId, "👍");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      emoji: string;
      count: number;
      reactedByMe: boolean;
    };
    expect(firstBody).toEqual({ emoji: "👍", count: 1, reactedByMe: true });

    const second = await toggle(app, channel.id, messageId, "👍");
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
    const messageId = await sendAndGetMessageId(appAlice, channel.id);

    await toggle(appAlice, channel.id, messageId, "🎉");
    const bobResult = await toggle(appBob, channel.id, messageId, "🎉");
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
    const messageId = await sendAndGetMessageId(app, channel.id);

    const received: ChatChannelEvent[] = [];
    channelSubscribers.subscribe(channel.id, (event) => received.push(event));

    await toggle(app, channel.id, messageId, "🚀");

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "chat.reaction",
      data: { messageId, emoji: "🚀", added: true },
    });
  });
});
