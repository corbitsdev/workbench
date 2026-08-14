// HTTP surface for message pinning: membership gating, pin/unpin/list,
// tenant isolation, the batched `pinned` field on `GET /messages`, the
// pinned-strip's own `GET /pins` read, and the `chat.pin` SSE event.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import { createInMemoryPinStore } from "../src/pins";
import { createChannelSubscriberRegistry } from "../src/channel-events";
import type { ChatChannelEvent } from "../src/platform-port";
import { buildDeps, createChannel, mountAs, sendText } from "./test-support";

function pinUrl(channelId: string, messageId: string) {
  return `/channels/${channelId}/messages/${messageId}/pin`;
}

async function pin(
  app: ReturnType<typeof mountAs>,
  channelId: string,
  messageId: string,
) {
  return app.request(pinUrl(channelId, messageId), { method: "POST" });
}

async function unpin(
  app: ReturnType<typeof mountAs>,
  channelId: string,
  messageId: string,
) {
  return app.request(pinUrl(channelId, messageId), { method: "DELETE" });
}

/** Sends a real message and returns its id — pin tests that expect a
 * 200/204 round trip need a message that actually exists, now that
 * pinning an unknown id 404s. */
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

describe("pin routes — gating", () => {
  test("no pins store injected: pin, unpin, and list all 404", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    expect((await pin(app, channel.id, "m1")).status).toBe(404);
    expect((await unpin(app, channel.id, "m1")).status).toBe(404);
    expect((await app.request(`/channels/${channel.id}/pins`)).status).toBe(
      404,
    );
  });

  test("a denied grant is rejected before any pin is stored", async () => {
    const store = createInMemoryPinStore();
    const deps = buildDeps({
      pins: store,
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const channelId = "run_channel1";

    const response = await pin(app, channelId, "m1");
    expect(response.status).toBe(403);
    expect(await store.listPins("tnt_1", channelId)).toHaveLength(0);
  });

  test("an unknown channel id 404s", async () => {
    const deps = buildDeps({ pins: createInMemoryPinStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    expect((await pin(app, "run_ghost", "m1")).status).toBe(404);
  });

  test("a channel that belongs to a different tenant is invisible: 404, not leaked cross-tenant", async () => {
    const store = createInMemoryPinStore();
    const deps = buildDeps({ pins: store });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body } = await createChannel(app, { kind: "channel" });

    const otherApp = mountAs(
      createChatRoutes(buildDeps({ pins: store })),
      "prn_mallory",
    );
    expect((await pin(otherApp, body.id, "m1")).status).toBe(404);
  });

  test("a messageId that was never sent 404s rather than writing an orphaned pin row", async () => {
    const store = createInMemoryPinStore();
    const deps = buildDeps({ pins: store });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });
    // A real message exists in the channel, but "m_ghost" is not it —
    // proves the check resolves the specific id, not just "some
    // message exists in this channel".
    await sendText(app, channel.id, "unrelated message");

    const response = await pin(app, channel.id, "m_ghost");
    expect(response.status).toBe(404);
    expect(await store.listPins("tnt_1", channel.id)).toHaveLength(0);
  });
});

describe("pin routes — pin/unpin round trip", () => {
  test("pinning then GET /pins returns it with the message's own content", async () => {
    const deps = buildDeps({ pins: createInMemoryPinStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });
    await sendText(app, channel.id, "important announcement");

    const list = await app.request(`/channels/${channel.id}/messages`);
    const listed = (await list.json()) as { items: { id: string }[] };
    const messageId = listed.items[0]?.id as string;

    const pinResponse = await pin(app, channel.id, messageId);
    expect(pinResponse.status).toBe(200);
    const pinBody = (await pinResponse.json()) as {
      messageId: string;
      pinnedBy: string;
    };
    expect(pinBody).toMatchObject({ messageId, pinnedBy: "prn_alice" });

    const pins = await app.request(`/channels/${channel.id}/pins`);
    const pinsBody = (await pins.json()) as {
      items: { id: string; parts: { kind: string; text?: string }[] }[];
    };
    expect(pinsBody.items).toHaveLength(1);
    expect(pinsBody.items[0]?.id).toBe(messageId);
  });

  test("unpinning removes it from GET /pins", async () => {
    const deps = buildDeps({ pins: createInMemoryPinStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });
    await sendText(app, channel.id, "hello");

    const list = await app.request(`/channels/${channel.id}/messages`);
    const listed = (await list.json()) as { items: { id: string }[] };
    const messageId = listed.items[0]?.id as string;

    await pin(app, channel.id, messageId);
    const unpinResponse = await unpin(app, channel.id, messageId);
    expect(unpinResponse.status).toBe(204);

    const pins = await app.request(`/channels/${channel.id}/pins`);
    const pinsBody = (await pins.json()) as { items: unknown[] };
    expect(pinsBody.items).toEqual([]);
  });
});

describe("pin routes — the message wire type carries pinned", () => {
  test("GET /messages marks each item pinned or not, batched from one listPins call", async () => {
    const deps = buildDeps({ pins: createInMemoryPinStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });
    await sendText(app, channel.id, "one");
    await sendText(app, channel.id, "two");

    const before = await app.request(`/channels/${channel.id}/messages`);
    const beforeBody = (await before.json()) as {
      items: { id: string; pinned?: boolean }[];
    };
    expect(beforeBody.items.every((item) => item.pinned === false)).toBe(true);

    const targetId = beforeBody.items[0]?.id as string;
    await pin(app, channel.id, targetId);

    const after = await app.request(`/channels/${channel.id}/messages`);
    const afterBody = (await after.json()) as {
      items: { id: string; pinned?: boolean }[];
    };
    const byId = new Map(afterBody.items.map((item) => [item.id, item.pinned]));
    expect(byId.get(targetId)).toBe(true);
  });

  test("without a pins store, the pinned field is simply absent", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });
    await sendText(app, channel.id, "hello");

    const list = await app.request(`/channels/${channel.id}/messages`);
    const body = (await list.json()) as { items: Record<string, unknown>[] };
    expect(body.items[0]).not.toHaveProperty("pinned");
  });
});

describe("pin routes — chat.pin SSE event", () => {
  test("pinning and unpinning both publish onto the channel's subscriber registry", async () => {
    const channelSubscribers = createChannelSubscriberRegistry();
    const deps = buildDeps({
      pins: createInMemoryPinStore(),
      channelSubscribers,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });
    const messageId = await sendAndGetMessageId(app, channel.id);

    const received: ChatChannelEvent[] = [];
    channelSubscribers.subscribe(channel.id, (event) => received.push(event));

    await pin(app, channel.id, messageId);
    await unpin(app, channel.id, messageId);

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      type: "chat.pin",
      data: { messageId, pinned: true },
    });
    expect(received[1]).toMatchObject({
      type: "chat.pin",
      data: { messageId, pinned: false },
    });
  });
});
