// The SSE subscriber registry: ephemeral, in-process fan-out for
// events that never touch storage — typing and settings-changed —
// merged onto a channel's SSE stream alongside the platform's own run
// events. Scoped to one `createChatRoutes` call, matching the
// per-router caching pattern `createInstanceRoutes` uses for its
// signing-key cache.
//
// `bridgeChannelStream` is the route's one call into this module: it
// wires both this registry and the platform's own event stream onto a
// live SSE stream, and owns the one defect that matters here — a
// write that fails (the client disconnected, but the abort signal
// hasn't fired yet) must drop that subscriber immediately rather than
// leaving it registered until `stream.onAbort` eventually runs. A
// dangling subscriber between disconnect and abort is a zombie: every
// event published in that window still attempts (and fails) a write.
import type { SSEStreamingApi } from "hono/streaming";
import type { ChannelEvents, ChatChannelEvent } from "./platform-port";

export type ChannelSubscriber = (event: ChatChannelEvent) => void;

export interface ChannelSubscriberRegistry {
  subscribe(channelId: string, subscriber: ChannelSubscriber): () => void;
  publish(channelId: string, event: ChatChannelEvent): void;
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
 * teardown the route calls from `stream.onAbort`. Each source gets its
 * own write-wrapper: a failed `writeSSE` (the client is already gone)
 * unsubscribes that source immediately rather than only logging and
 * waiting for abort — the fix for the zombie-subscriber defect.
 */
export function bridgeChannelStream(input: {
  registry: ChannelSubscriberRegistry;
  platform: ChannelEvents;
  channelId: string;
  stream: SSEStreamingApi;
}): () => void {
  const writeOrUnsubscribe = (
    event: ChatChannelEvent,
    unsubscribe: () => void,
  ) => {
    input.stream
      .writeSSE({ event: event.type, data: JSON.stringify(event.data) })
      .catch(() => unsubscribe());
  };

  let unsubscribeLocal: () => void = () => undefined;
  unsubscribeLocal = input.registry.subscribe(input.channelId, (event) => {
    writeOrUnsubscribe(event, () => unsubscribeLocal());
  });

  let unsubscribePlatform: () => void = () => undefined;
  unsubscribePlatform = input.platform.subscribeToChannel(
    input.channelId,
    (event) => {
      writeOrUnsubscribe(event, () => unsubscribePlatform());
    },
  );

  return () => {
    unsubscribeLocal();
    unsubscribePlatform();
  };
}
