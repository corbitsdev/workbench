// The SSE subscriber registry: ephemeral, in-process fan-out for
// events that never touch storage — typing and settings-changed —
// merged onto a workbench's SSE stream alongside the platform's own run
// events. Scoped to one `createChatRoutes` call, matching the
// per-router caching pattern `createInstanceRoutes` uses for its
// signing-key cache.
//
// `bridgeWorkbenchStream` is the route's one call into this module: it
// wires both this registry and the platform's own event stream onto a
// live SSE stream, and owns two defects that matter here.
//
// 1. A write that fails (the client disconnected, but the abort
//    signal hasn't fired yet) must drop that subscriber immediately
//    rather than leaving it registered until `stream.onAbort`
//    eventually runs. A dangling subscriber between disconnect and
//    abort is a zombie: every event published in that window still
//    attempts (and fails) a write.
// 2. Access must be re-checked on every delivered event, not only at
//    connect time. The route resolves access once before opening the
//    stream, but a share or a share member's row can be revoked at
//    any point during a long-lived connection; without a live check
//    the subscriber would keep receiving every subsequent event
//    forever. The caller passes an `authorize` callback (the same
//    fail-closed `resolveWorkbenchAccess` check the route ran up
//    front); this module calls it before every write and, the moment
//    it returns `false`, unsubscribes from both sources and closes
//    the stream so the client's connection actually ends. This makes
//    revocation live relative to the workbench's own traffic — the very
//    next event delivered after a revocation is the last one a
//    revoked subscriber sees — not instantly on a workbench that goes
//    quiet. A truly instant kill would need a poll/heartbeat
//    independent of traffic; that's a real, disclosed scope cut, not
//    a hidden gap, and out of scope here.
import type { SSEStreamingApi } from "hono/streaming";
import type { WorkbenchEvents, ChatWorkbenchEvent } from "./platform-port";
import { ChatPresenceSnapshotEventData } from "./stream-events";
import type { WorkbenchPresenceRegistry } from "./workbench-presence";

export type WorkbenchSubscriber = (event: ChatWorkbenchEvent) => void;

export interface WorkbenchSubscriberRegistry {
  subscribe(workbenchId: string, subscriber: WorkbenchSubscriber): () => void;
  publish(workbenchId: string, event: ChatWorkbenchEvent): void;
}

/**
 * Wraps a `WorkbenchEvents` so every workbench has at most one live upstream
 * subscription, fanned out in-process to however many local callers ask
 * for it — the fix for CL-6186. Without this, each SSE connection called
 * `platform.subscribeToWorkbench` directly: N browser tabs open on the same
 * workbench meant N folded-run lookups and N sidecar subscriptions for the
 * same workbench, and a reconnect storm (every tab's `EventSource` retrying
 * at once after a hub restart) turned into a proportional storm of DB
 * lookups and sidecar subscribes that starved both. Ref-counted per
 * workbench instead: the first subscriber triggers the one upstream call,
 * every later subscriber for that workbench just joins the fan-out, and the
 * upstream subscription is released only once the last local subscriber
 * for that workbench goes away.
 */
export function createPlatformWorkbenchFanout(
  platform: WorkbenchEvents,
): WorkbenchEvents {
  interface Entry {
    subscribers: Set<WorkbenchSubscriber>;
    unsubscribeUpstream: () => void;
  }
  const entriesByWorkbench = new Map<string, Entry>();

  return {
    subscribeToWorkbench(workbenchId, onEvent) {
      let entry = entriesByWorkbench.get(workbenchId);
      if (entry === undefined) {
        const subscribers = new Set<WorkbenchSubscriber>();
        const unsubscribeUpstream = platform.subscribeToWorkbench(
          workbenchId,
          (event) => {
            for (const subscriber of subscribers) subscriber(event);
          },
        );
        entry = { subscribers, unsubscribeUpstream };
        entriesByWorkbench.set(workbenchId, entry);
      }
      entry.subscribers.add(onEvent);

      return () => {
        const current = entriesByWorkbench.get(workbenchId);
        if (current === undefined || !current.subscribers.delete(onEvent)) {
          return;
        }
        if (current.subscribers.size === 0) {
          current.unsubscribeUpstream();
          entriesByWorkbench.delete(workbenchId);
        }
      };
    },
  };
}

export function createWorkbenchSubscriberRegistry(): WorkbenchSubscriberRegistry {
  const subscribersByWorkbench = new Map<string, Set<WorkbenchSubscriber>>();
  return {
    subscribe(workbenchId, subscriber) {
      let subscribers = subscribersByWorkbench.get(workbenchId);
      if (subscribers === undefined) {
        subscribers = new Set();
        subscribersByWorkbench.set(workbenchId, subscribers);
      }
      subscribers.add(subscriber);
      return () => {
        subscribers?.delete(subscriber);
        if (subscribers?.size === 0) {
          subscribersByWorkbench.delete(workbenchId);
        }
      };
    },
    publish(workbenchId, event) {
      const subscribers = subscribersByWorkbench.get(workbenchId);
      if (subscribers === undefined) return;
      for (const subscriber of subscribers) subscriber(event);
    },
  };
}

/**
 * Wires a live SSE stream to both the local registry and the
 * platform's own per-workbench event stream, and returns the combined
 * teardown the route calls from `stream.onAbort`. Before every event
 * from either source is written, `authorize()` re-runs the same
 * fail-closed access check the route ran at connect time; a `false`
 * result unsubscribes both sources and closes the stream rather than
 * writing the event, so a revoked share or share member stops
 * receiving events on the very next one published. A failed
 * `writeSSE` (the client is already gone) unsubscribes that source
 * immediately rather than only logging and waiting for abort — the
 * fix for the zombie-subscriber defect.
 */
export function bridgeWorkbenchStream(input: {
  registry: WorkbenchSubscriberRegistry;
  platform: WorkbenchEvents;
  workbenchId: string;
  stream: SSEStreamingApi;
  authorize: () => Promise<boolean>;
  /**
   * Wires this connection into the workbench's "who's here" roster —
   * see `./workbench-presence.ts`. Omitted, this stream carries no
   * presence at all (the original behavior): a caller with no presence
   * feature wired sees nothing change. When present, connecting
   * registers one live connection for `principalId`, hands this
   * stream a `chat.presence.snapshot` of the roster as it stands right
   * now, and broadcasts a `chat.presence` `"online"` delta; tearing
   * down releases the connection and, only once this was the
   * principal's last one on this workbench, broadcasts `"offline"`.
   */
  presence?: {
    registry: WorkbenchPresenceRegistry;
    principalId: string;
  };
}): () => void {
  let tornDown = false;

  let unsubscribeLocal: () => void = () => undefined;
  let unsubscribePlatform: () => void = () => undefined;
  const teardownPresence = () => {
    if (input.presence === undefined) return;
    const wentOffline = input.presence.registry.disconnect(
      input.workbenchId,
      input.presence.principalId,
    );
    if (!wentOffline) return;
    input.registry.publish(input.workbenchId, {
      type: "chat.presence",
      data: {
        principalId: input.presence.principalId,
        state: "offline",
        lastActiveAt: new Date().toISOString(),
      },
    });
  };
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    unsubscribeLocal();
    unsubscribePlatform();
    teardownPresence();
  };

  const deliver = async (event: ChatWorkbenchEvent) => {
    if (tornDown) return;
    if (!(await input.authorize())) {
      teardown();
      await input.stream.close().catch(() => undefined);
      return;
    }
    try {
      await input.stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event.data),
      });
    } catch {
      teardown();
    }
  };

  unsubscribeLocal = input.registry.subscribe(input.workbenchId, (event) => {
    void deliver(event);
  });

  // The platform side resolves a folded run before it can subscribe
  // (see `subscribeToWorkbench` in `platform-adapter.ts`); a transient
  // failure there (the run isn't back yet after a hub restart, a slow
  // DB) must degrade this stream to registry-only rather than take the
  // whole SSE connection down — a client still gets typing/settings
  // events and its own poll fallback covers the rest.
  try {
    unsubscribePlatform = input.platform.subscribeToWorkbench(
      input.workbenchId,
      (event) => {
        void deliver(event);
      },
    );
  } catch {
    unsubscribePlatform = () => undefined;
  }

  if (input.presence !== undefined) {
    const { registry: presenceRegistry, principalId } = input.presence;
    presenceRegistry.connect(input.workbenchId, principalId);
    const snapshot = ChatPresenceSnapshotEventData.assert({
      members: presenceRegistry.snapshot(input.workbenchId),
    });
    void input.stream
      .writeSSE({
        event: "chat.presence.snapshot",
        data: JSON.stringify(snapshot),
      })
      .catch(() => undefined);
    input.registry.publish(input.workbenchId, {
      type: "chat.presence",
      data: {
        principalId,
        state: "online",
        lastActiveAt: new Date().toISOString(),
      },
    });
  }

  return teardown;
}
