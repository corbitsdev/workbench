// The SSE subscriber registry: ephemeral, in-process fan-out for
// events that never touch storage — typing and settings-changed —
// merged onto a channel's SSE stream alongside the platform's own run
// events. Scoped to one `createChatRoutes` call, matching the
// per-router caching pattern `createInstanceRoutes` uses for its
// signing-key cache.
//
// `bridgeChannelStream` is the route's one call into this module: it
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
//    fail-closed `resolveChannelAccess` check the route ran up
//    front); this module calls it before every write and, the moment
//    it returns `false`, unsubscribes from both sources and closes
//    the stream so the client's connection actually ends. This makes
//    revocation live relative to the channel's own traffic — the very
//    next event delivered after a revocation is the last one a
//    revoked subscriber sees — not instantly on a channel that goes
//    quiet. A truly instant kill would need a poll/heartbeat
//    independent of traffic; that's a real, disclosed scope cut, not
//    a hidden gap, and out of scope here.
import type { SSEStreamingApi } from "hono/streaming";
import type { ChannelEvents, ChatChannelEvent } from "./platform-port";

export type ChannelSubscriber = (event: ChatChannelEvent) => void;

export interface ChannelSubscriberRegistry {
  subscribe(channelId: string, subscriber: ChannelSubscriber): () => void;
  publish(channelId: string, event: ChatChannelEvent): void;
}

/**
 * Wraps a `ChannelEvents` so every channel has at most one live upstream
 * subscription, fanned out in-process to however many local callers ask
 * for it — the fix for CL-6186. Without this, each SSE connection called
 * `platform.subscribeToChannel` directly: N browser tabs open on the same
 * channel meant N folded-run lookups and N sidecar subscriptions for the
 * same channel, and a reconnect storm (every tab's `EventSource` retrying
 * at once after a hub restart) turned into a proportional storm of DB
 * lookups and sidecar subscribes that starved both. Ref-counted per
 * channel instead: the first subscriber triggers the one upstream call,
 * every later subscriber for that channel just joins the fan-out, and the
 * upstream subscription is released only once the last local subscriber
 * for that channel goes away.
 */
export function createPlatformChannelFanout(
  platform: ChannelEvents,
): ChannelEvents {
  interface Entry {
    subscribers: Set<ChannelSubscriber>;
    unsubscribeUpstream: () => void;
  }
  const entriesByChannel = new Map<string, Entry>();

  return {
    subscribeToChannel(channelId, onEvent) {
      let entry = entriesByChannel.get(channelId);
      if (entry === undefined) {
        const subscribers = new Set<ChannelSubscriber>();
        const unsubscribeUpstream = platform.subscribeToChannel(
          channelId,
          (event) => {
            for (const subscriber of subscribers) subscriber(event);
          },
        );
        entry = { subscribers, unsubscribeUpstream };
        entriesByChannel.set(channelId, entry);
      }
      entry.subscribers.add(onEvent);

      return () => {
        const current = entriesByChannel.get(channelId);
        if (current === undefined || !current.subscribers.delete(onEvent)) {
          return;
        }
        if (current.subscribers.size === 0) {
          current.unsubscribeUpstream();
          entriesByChannel.delete(channelId);
        }
      };
    },
  };
}

export function createChannelSubscriberRegistry(): ChannelSubscriberRegistry {
  const subscribersByChannel = new Map<string, Set<ChannelSubscriber>>();
  return {
    subscribe(channelId, subscriber) {
      let subscribers = subscribersByChannel.get(channelId);
      if (subscribers === undefined) {
        subscribers = new Set();
        subscribersByChannel.set(channelId, subscribers);
      }
      subscribers.add(subscriber);
      return () => {
        subscribers?.delete(subscriber);
        if (subscribers?.size === 0) {
          subscribersByChannel.delete(channelId);
        }
      };
    },
    publish(channelId, event) {
      const subscribers = subscribersByChannel.get(channelId);
      if (subscribers === undefined) return;
      for (const subscriber of subscribers) subscriber(event);
    },
  };
}

/**
 * Wires a live SSE stream to both the local registry and the
 * platform's own per-channel event stream, and returns the combined
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
export function bridgeChannelStream(input: {
  registry: ChannelSubscriberRegistry;
  platform: ChannelEvents;
  channelId: string;
  stream: SSEStreamingApi;
  authorize: () => Promise<boolean>;
}): () => void {
  let tornDown = false;

  let unsubscribeLocal: () => void = () => undefined;
  let unsubscribePlatform: () => void = () => undefined;
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    unsubscribeLocal();
    unsubscribePlatform();
  };

  const deliver = async (event: ChatChannelEvent) => {
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

  unsubscribeLocal = input.registry.subscribe(input.channelId, (event) => {
    void deliver(event);
  });

  // The platform side resolves a folded run before it can subscribe
  // (see `subscribeToChannel` in `platform-adapter.ts`); a transient
  // failure there (the run isn't back yet after a hub restart, a slow
  // DB) must degrade this stream to registry-only rather than take the
  // whole SSE connection down — a client still gets typing/settings
  // events and its own poll fallback covers the rest.
  try {
    unsubscribePlatform = input.platform.subscribeToChannel(
      input.channelId,
      (event) => {
        void deliver(event);
      },
    );
  } catch {
    unsubscribePlatform = () => undefined;
  }

  return teardown;
}
