// Unit tests for the SSE subscriber registry and its stream bridge —
// split out of `routes.test.ts` alongside `./workbench-events.ts`. The
// live-revocation behavior itself (an `authorize` callback going false
// mid-stream) is covered end to end over real HTTP in
// `workbench-share-routes.test.ts`; these tests only pin the bridge's
// own unit-level contract with a stub `authorize`.
import { describe, expect, test } from "bun:test";
import {
  bridgeWorkbenchStream,
  createWorkbenchSubscriberRegistry,
  createPlatformWorkbenchFanout,
} from "../src/workbench-events";
import { createWorkbenchPresenceRegistry } from "../src/workbench-presence";
import type { ChatWorkbenchEvent, WorkbenchEvents } from "../src/platform-port";

const alwaysAuthorized = () => Promise.resolve(true);

function fakeStream(
  writeSSE: (message: unknown) => Promise<void>,
  close: () => Promise<void> = () => Promise.resolve(),
) {
  return { writeSSE, close } as unknown as Parameters<
    typeof bridgeWorkbenchStream
  >[0]["stream"];
}

function noopPlatformEvents(): WorkbenchEvents {
  return {
    subscribeToWorkbench() {
      return () => undefined;
    },
  };
}

describe("createWorkbenchSubscriberRegistry", () => {
  test("publishing delivers to every subscriber of that workbench", () => {
    const registry = createWorkbenchSubscriberRegistry();
    const received: ChatWorkbenchEvent[] = [];
    registry.subscribe("chan_1", (event) => received.push(event));

    registry.publish("chan_1", { type: "chat.typing", data: {} });

    expect(received).toHaveLength(1);
  });

  test("a workbench with no subscribers is a no-op publish", () => {
    const registry = createWorkbenchSubscriberRegistry();
    expect(() =>
      registry.publish("chan_none", { type: "chat.typing", data: {} }),
    ).not.toThrow();
  });

  test("unsubscribing stops delivery", () => {
    const registry = createWorkbenchSubscriberRegistry();
    const received: ChatWorkbenchEvent[] = [];
    const unsubscribe = registry.subscribe("chan_1", (event) =>
      received.push(event),
    );
    unsubscribe();

    registry.publish("chan_1", { type: "chat.typing", data: {} });

    expect(received).toHaveLength(0);
  });
});

describe("createPlatformWorkbenchFanout", () => {
  test("N subscribers on one workbench share a single upstream subscription", () => {
    let subscribeCalls = 0;
    let upstreamUnsubscribeCalls = 0;
    const platform: WorkbenchEvents = {
      subscribeToWorkbench() {
        subscribeCalls += 1;
        return () => {
          upstreamUnsubscribeCalls += 1;
        };
      },
    };
    const fanout = createPlatformWorkbenchFanout(platform);

    const unsubscribeA = fanout.subscribeToWorkbench("chan_1", () => undefined);
    const unsubscribeB = fanout.subscribeToWorkbench("chan_1", () => undefined);
    const unsubscribeC = fanout.subscribeToWorkbench("chan_1", () => undefined);

    expect(subscribeCalls).toBe(1);

    unsubscribeA();
    unsubscribeB();
    expect(upstreamUnsubscribeCalls).toBe(0);

    unsubscribeC();
    expect(upstreamUnsubscribeCalls).toBe(1);
  });

  test("a fanned-out event reaches every local subscriber of that workbench", () => {
    let deliver: ((event: ChatWorkbenchEvent) => void) | undefined;
    const platform: WorkbenchEvents = {
      subscribeToWorkbench(_workbenchId, onEvent) {
        deliver = onEvent;
        return () => undefined;
      },
    };
    const fanout = createPlatformWorkbenchFanout(platform);
    const receivedA: ChatWorkbenchEvent[] = [];
    const receivedB: ChatWorkbenchEvent[] = [];
    fanout.subscribeToWorkbench("chan_1", (event) => receivedA.push(event));
    fanout.subscribeToWorkbench("chan_1", (event) => receivedB.push(event));

    deliver?.({ type: "chat.agent", data: {} });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
  });

  test("releasing and resubscribing to the same workbench re-subscribes upstream", () => {
    let subscribeCalls = 0;
    const platform: WorkbenchEvents = {
      subscribeToWorkbench() {
        subscribeCalls += 1;
        return () => undefined;
      },
    };
    const fanout = createPlatformWorkbenchFanout(platform);

    fanout.subscribeToWorkbench("chan_1", () => undefined)();
    fanout.subscribeToWorkbench("chan_1", () => undefined);

    expect(subscribeCalls).toBe(2);
  });

  test("different workbenches each get their own upstream subscription", () => {
    let subscribeCalls = 0;
    const platform: WorkbenchEvents = {
      subscribeToWorkbench() {
        subscribeCalls += 1;
        return () => undefined;
      },
    };
    const fanout = createPlatformWorkbenchFanout(platform);

    fanout.subscribeToWorkbench("chan_1", () => undefined);
    fanout.subscribeToWorkbench("chan_2", () => undefined);

    expect(subscribeCalls).toBe(2);
  });
});

describe("bridgeWorkbenchStream", () => {
  test("forwards a registry publish onto the stream as an SSE write", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    const writes: unknown[] = [];
    const stream = fakeStream((message) => {
      writes.push(message);
      return Promise.resolve();
    });

    bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
    });
    registry.publish("chan_1", { type: "chat.typing", data: { a: 1 } });
    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toHaveLength(1);
  });

  test("a subscriber whose write rejects is removed rather than left dangling", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    let writeCount = 0;
    const stream = fakeStream(() => {
      writeCount += 1;
      return Promise.reject(new Error("client disconnected"));
    });

    bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
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

  test("a platform subscribe that throws still opens the stream, registry-only", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    const writes: unknown[] = [];
    const stream = fakeStream((message) => {
      writes.push(message);
      return Promise.resolve();
    });
    const throwingPlatform: WorkbenchEvents = {
      subscribeToWorkbench() {
        throw new Error("folded run not resolved yet");
      },
    };

    expect(() =>
      bridgeWorkbenchStream({
        registry,
        platform: throwingPlatform,
        workbenchId: "chan_1",
        stream,
        authorize: alwaysAuthorized,
      }),
    ).not.toThrow();

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toHaveLength(1);
  });

  test("authorize going false unsubscribes both sources and closes the stream, without writing the event", async () => {
    const registry = createWorkbenchSubscriberRegistry();
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
    const platform: WorkbenchEvents = {
      subscribeToWorkbench() {
        return () => {
          platformUnsubscribed = true;
        };
      },
    };

    bridgeWorkbenchStream({
      registry,
      platform,
      workbenchId: "chan_1",
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

  describe("presence", () => {
    test("connecting delivers a snapshot directly to this stream and broadcasts an online delta", async () => {
      const registry = createWorkbenchSubscriberRegistry();
      const presenceRegistry = createWorkbenchPresenceRegistry();
      presenceRegistry.connect("chan_1", "prn_bob");
      const writes: { event?: string; data?: string }[] = [];
      const stream = fakeStream((message) => {
        writes.push(message as { event?: string; data?: string });
        return Promise.resolve();
      });

      bridgeWorkbenchStream({
        registry,
        platform: noopPlatformEvents(),
        workbenchId: "chan_1",
        stream,
        authorize: alwaysAuthorized,
        presence: { registry: presenceRegistry, principalId: "prn_ada" },
      });
      await Promise.resolve();
      await Promise.resolve();

      const snapshotWrite = writes.find(
        (write) => write.event === "chat.presence.snapshot",
      );
      expect(snapshotWrite).toBeDefined();
      const snapshot = JSON.parse(snapshotWrite?.data ?? "{}") as {
        members: { principalId: string }[];
      };
      // The connecting principal is already in the roster this stream
      // is handed — `connect` happens before the snapshot is read.
      expect(
        snapshot.members.map((member) => member.principalId).sort(),
      ).toEqual(["prn_ada", "prn_bob"]);

      const onlineWrite = writes.find(
        (write) => write.event === "chat.presence",
      );
      expect(onlineWrite).toBeDefined();
      expect(JSON.parse(onlineWrite?.data ?? "{}")).toMatchObject({
        principalId: "prn_ada",
        state: "online",
      });
    });

    test("tearing down a principal's only connection broadcasts an offline delta", async () => {
      const registry = createWorkbenchSubscriberRegistry();
      const presenceRegistry = createWorkbenchPresenceRegistry();
      const stream = fakeStream(() => Promise.resolve());
      // A separate observer, not the stream tearing down — that stream
      // has already unsubscribed itself by the time the offline delta
      // publishes, exactly like any other subscriber that just closed.
      const observed: ChatWorkbenchEvent[] = [];
      registry.subscribe("chan_1", (event) => observed.push(event));

      const teardown = bridgeWorkbenchStream({
        registry,
        platform: noopPlatformEvents(),
        workbenchId: "chan_1",
        stream,
        authorize: alwaysAuthorized,
        presence: { registry: presenceRegistry, principalId: "prn_ada" },
      });
      await Promise.resolve();
      await Promise.resolve();
      observed.length = 0;

      teardown();
      await Promise.resolve();
      await Promise.resolve();

      expect(presenceRegistry.snapshot("chan_1")).toEqual([]);
      const offlineEvent = observed.find(
        (event) => event.type === "chat.presence",
      );
      expect(offlineEvent).toBeDefined();
      expect(offlineEvent?.data).toMatchObject({
        principalId: "prn_ada",
        state: "offline",
      });
    });

    test("tearing down one of two open connections for the same principal does not broadcast offline", async () => {
      const registry = createWorkbenchSubscriberRegistry();
      const presenceRegistry = createWorkbenchPresenceRegistry();
      const writesA: { event?: string; data?: string }[] = [];
      const writesB: { event?: string; data?: string }[] = [];
      const streamA = fakeStream((message) => {
        writesA.push(message as { event?: string; data?: string });
        return Promise.resolve();
      });
      const streamB = fakeStream((message) => {
        writesB.push(message as { event?: string; data?: string });
        return Promise.resolve();
      });

      const teardownA = bridgeWorkbenchStream({
        registry,
        platform: noopPlatformEvents(),
        workbenchId: "chan_1",
        stream: streamA,
        authorize: alwaysAuthorized,
        presence: { registry: presenceRegistry, principalId: "prn_ada" },
      });
      bridgeWorkbenchStream({
        registry,
        platform: noopPlatformEvents(),
        workbenchId: "chan_1",
        stream: streamB,
        authorize: alwaysAuthorized,
        presence: { registry: presenceRegistry, principalId: "prn_ada" },
      });
      await Promise.resolve();
      await Promise.resolve();
      writesB.length = 0;

      teardownA();
      await Promise.resolve();
      await Promise.resolve();

      // Still connected via the second stream — no offline delta.
      expect(
        presenceRegistry.snapshot("chan_1").map((member) => member.principalId),
      ).toEqual(["prn_ada"]);
      expect(writesB.some((write) => write.event === "chat.presence")).toBe(
        false,
      );
    });

    test("no presence option: the original no-presence behavior is unchanged", async () => {
      const registry = createWorkbenchSubscriberRegistry();
      const writes: unknown[] = [];
      const stream = fakeStream((message) => {
        writes.push(message);
        return Promise.resolve();
      });

      bridgeWorkbenchStream({
        registry,
        platform: noopPlatformEvents(),
        workbenchId: "chan_1",
        stream,
        authorize: alwaysAuthorized,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(writes).toHaveLength(0);
    });
  });
});
