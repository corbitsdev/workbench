// The browser-safe half of `@corbits/presence`: no React, no DOM APIs
// assumed beyond `fetch` and `EventSource` (both dependency-injectable, so
// this module is unit-testable in plain `bun:test` with fakes — mirroring
// `packages/chat-ui/src/use-channel-stream.ts`'s reconnect/backoff shape,
// but exposed as a plain subscribe/callback API rather than a React hook.
// A thin hook wrapping `connectPresence` belongs in the consuming app, not
// here — this package never depends on React.
import type {
  PresenceCursor,
  PresenceState,
  PresenceStatePatch,
} from "./room-registry";

/** The one field this module reads off a real `MessageEvent` — spelled out
 * locally rather than typed against the DOM lib's `MessageEvent`, since
 * this package's tsconfig deliberately doesn't pull in DOM globals (see
 * `openEventSource`'s default below for why). */
export interface PresenceStreamEvent {
  readonly data: string;
}

/** The minimal `EventSource` surface this module uses — small enough that a
 * test fake can implement it directly, rather than the full DOM interface. */
export interface PresenceEventSourceLike {
  addEventListener(
    type: string,
    listener: (event: PresenceStreamEvent) => void,
  ): void;
  close(): void;
}

/** The minimal `fetch` surface this module uses. */
export type PresenceFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean }>;

export interface PresenceClientOptions {
  /** The room's base URL, e.g. `/api/tenants/tnt_1/presence/rooms/channel:chn_1`. */
  readonly roomUrl: string;
  readonly displayName?: string;
  readonly heartbeatIntervalMs?: number;
  readonly fetchImpl?: PresenceFetch;
  readonly openEventSource?: (streamUrl: string) => PresenceEventSourceLike;
}

/**
 * The real global `EventSource` constructor, cast to the minimal shape
 * this module needs. A real cast, not a lie: every `EventSource` in every
 * browser satisfies `PresenceEventSourceLike` structurally — this package
 * just doesn't add the DOM lib to its own tsconfig (doing so would pull
 * DOM's `BodyInit` into scope for the whole package, including the
 * server-side route modules that never touch it).
 */
function defaultOpenEventSource(streamUrl: string): PresenceEventSourceLike {
  const EventSourceCtor = (
    globalThis as unknown as {
      EventSource: new (url: string) => PresenceEventSourceLike;
    }
  ).EventSource;
  return new EventSourceCtor(streamUrl);
}

export interface PresenceHandle {
  /** Publishes (and immediately heartbeats) a cursor position. */
  publishCursor(cursor: PresenceCursor): void;
  /** Publishes (and immediately heartbeats) a typing flag. */
  publishTyping(typing: boolean): void;
  /** Subscribes to every room snapshot; fires once with whatever has been received so far. */
  subscribe(listener: (members: readonly PresenceState[]) => void): () => void;
  /** Leaves the room and tears down the stream/heartbeat timer. */
  disconnect(): void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

function parseMembers(data: string): readonly PresenceState[] {
  try {
    const parsed: unknown = JSON.parse(data);
    return Array.isArray(parsed) ? (parsed as PresenceState[]) : [];
  } catch {
    return [];
  }
}

function defaultFetch(
  ...args: Parameters<PresenceFetch>
): ReturnType<PresenceFetch> {
  return (globalThis as unknown as { fetch: PresenceFetch }).fetch(...args);
}

export function connectPresence(
  options: PresenceClientOptions,
): PresenceHandle {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const openEventSource = options.openEventSource ?? defaultOpenEventSource;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const listeners = new Set<(members: readonly PresenceState[]) => void>();
  let latestMembers: readonly PresenceState[] = [];
  let disconnected = false;

  const notify = (members: readonly PresenceState[]) => {
    latestMembers = members;
    for (const listener of listeners) listener(members);
  };

  const post = (path: string, body: unknown) =>
    fetchImpl(`${options.roomUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).catch(() => undefined);

  void post("join", { displayName: options.displayName });

  const source = openEventSource(`${options.roomUrl}/stream`);
  source.addEventListener("presence.state", (event) => {
    if (disconnected) return;
    notify(parseMembers(event.data));
  });

  const heartbeatTimer = setInterval(() => {
    if (disconnected) return;
    void post("heartbeat", {});
  }, heartbeatIntervalMs);

  return {
    publishCursor(cursor) {
      if (disconnected) return;
      const patch: PresenceStatePatch = { cursor };
      void post("heartbeat", patch);
    },

    publishTyping(typing) {
      if (disconnected) return;
      const patch: PresenceStatePatch = { typing };
      void post("heartbeat", patch);
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(latestMembers);
      return () => {
        listeners.delete(listener);
      };
    },

    disconnect() {
      if (disconnected) return;
      disconnected = true;
      clearInterval(heartbeatTimer);
      source.close();
      listeners.clear();
      // Best-effort: the room drops this principal on its own heartbeat
      // timeout even if this never arrives (page unload racing the
      // request), so a failed leave is not a correctness bug.
      void post("leave", {});
    },
  };
}
