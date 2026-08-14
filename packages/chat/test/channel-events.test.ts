// Unit tests for the SSE subscriber registry and its stream bridge —
// split out of `routes.test.ts` alongside `./channel-events.ts`. The
// live-revocation behavior itself (an `authorize` callback going false
// mid-stream) is covered end to end over real HTTP in
// `channel-share-routes.test.ts`; these tests only pin the bridge's
// own unit-level contract with a stub `authorize`.
import { describe, expect, test } from "bun:test";
import {
  bridgeChannelStream,
  createChannelSubscriberRegistry,
} from "../src/channel-events";
import type { ChatChannelEvent, ChannelEvents } from "../src/platform-port";

const alwaysAuthorized = () => Promise.resolve(true);

function fakeStream(
  writeSSE: (message: unknown) => Promise<void>,
  close: () => Promise<void> = () => Promise.resolve(),
) {
  return { writeSSE, close } as unknown as Parameters<
    typeof bridgeChannelStream
  >[0]["stream"];
}

function noopPlatformEvents(): ChannelEvents {
  return {
    subscribeToChannel() {
      return () => undefined;
    },
  };
}

describe("createChannelSubscriberRegistry", () => {
  test("publishing delivers to every subscriber of that channel", () => {
    const registry = createChannelSubscriberRegistry();
    const received: ChatChannelEvent[] = [];
    registry.subscribe("chan_1", (event) => received.push(event));

    registry.publish("chan_1", { type: "chat.typing", data: {} });

    expect(received).toHaveLength(1);
  });

  test("a channel with no subscribers is a no-op publish", () => {
    const registry = createChannelSubscriberRegistry();
    expect(() =>
      registry.publish("chan_none", { type: "chat.typing", data: {} }),
    ).not.toThrow();
  });

  test("unsubscribing stops delivery", () => {
    const registry = createChannelSubscriberRegistry();
    const received: ChatChannelEvent[] = [];
    const unsubscribe = registry.subscribe("chan_1", (event) =>
      received.push(event),
    );
    unsubscribe();

    registry.publish("chan_1", { type: "chat.typing", data: {} });

    expect(received).toHaveLength(0);
  });
});

describe("bridgeChannelStream", () => {
  test("forwards a registry publish onto the stream as an SSE write", async () => {
    const registry = createChannelSubscriberRegistry();
    const writes: unknown[] = [];
    const stream = fakeStream((message) => {
      writes.push(message);
      return Promise.resolve();
    });

    bridgeChannelStream({
      registry,
      platform: noopPlatformEvents(),
      channelId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
    });
    registry.publish("chan_1", { type: "chat.typing", data: { a: 1 } });
    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toHaveLength(1);
  });

  test("a subscriber whose write rejects is removed rather than left dangling", async () => {
    const registry = createChannelSubscriberRegistry();
    let writeCount = 0;
    const stream = fakeStream(() => {
      writeCount += 1;
      return Promise.reject(new Error("client disconnected"));
    });

    bridgeChannelStream({
      registry,
      platform: noopPlatformEvents(),
      channelId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
    });

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    // Let the rejected write's `.catch` run before publishing again.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await Promise.resolve();
    await Promise.resolve();

    // The first publish attempted a write that failed and unsubscribed
    // the local subscriber; the second publish must not reach it again
    // — a zombie subscriber would keep attempting (and failing) writes
    // forever.
    expect(writeCount).toBe(1);
  });

  test("authorize going false unsubscribes both sources and closes the stream, without writing the event", async () => {
    const registry = createChannelSubscriberRegistry();
    const writes: unknown[] = [];
    let closeCount = 0;
    const stream = fakeStream(
      (message) => {
        writes.push(message);
        return Promise.resolve();
      },
      () => {
        closeCount += 1;
        return Promise.resolve();
      },
    );
    let platformUnsubscribed = false;
    const platform: ChannelEvents = {
      subscribeToChannel() {
        return () => {
          platformUnsubscribed = true;
        };
      },
    };

    bridgeChannelStream({
      registry,
      platform,
      channelId: "chan_1",
      stream,
      authorize: () => Promise.resolve(false),
    });

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toHaveLength(0);
    expect(closeCount).toBe(1);
    expect(platformUnsubscribed).toBe(true);

    // A further publish after revocation must not write, or close again.
    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toHaveLength(0);
    expect(closeCount).toBe(1);
  });
});
