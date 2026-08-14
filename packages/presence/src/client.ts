// The browser-safe half of `@corbits/presence`: no React, no DOM APIs
// assumed beyond `fetch` and `EventSource` (both dependency-injectable, so
// this module is unit-testable in plain `bun:test` with fakes — mirroring
// `packages/chat-ui/src/use-channel-stream.ts`'s reconnect/backoff shape,
// but exposed as a plain subscribe/callback API rather than a React hook.
// A thin hook wrapping `connectPresence` belongs in the consuming app, not
// here — this package never depends on React.
import * as Y from "yjs";

import { decodeBase64, encodeBase64 } from "./base64";
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

/** The minimal `fetch` surface this module uses. `json()` is only ever
 * read when a `doc` is configured (to pull `docUpdate` off the join
 * response) — a real `Response` satisfies this structurally, no cast
 * needed. */
export type PresenceFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface PresenceClientOptions {
  /** The room's base URL, e.g. `/api/tenants/tnt_1/presence/rooms/channel:chn_1`. */
  readonly roomUrl: string;
  readonly displayName?: string;
  readonly heartbeatIntervalMs?: number;
  readonly fetchImpl?: PresenceFetch;
  readonly openEventSource?: (streamUrl: string) => PresenceEventSourceLike;
  /**
   * When provided, this connection speaks doc sync as well as awareness:
   * the join response's `docUpdate` seeds it, remote `doc.update` SSE
   * events apply into it, and its own local changes are relayed to the
   * room's `/update` endpoint. Omit for an awareness-only connection
   * (e.g. the channel who's-here stack, which has no doc content) — the
   * extra machinery below only activates when a caller actually hands
   * over a `Y.Doc` to keep in sync.
   */
  readonly doc?: Y.Doc;
  /**
   * Called for every `doc.saved` event the room's stream carries — the
   * only honest source for a "Saved · v12" line, since a debounced
   * server-side write finishing is not something the client can infer
   * from anything it did locally.
   */
  readonly onSaved?: (info: { version: number; savedAt: number }) => void;
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

/** `undefined` for anything that isn't a well-formed `{update: string}` payload — the same "parse, don't crash on a bad event" stance `parseMembers` takes. */
function parseDocUpdateEvent(data: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "update" in parsed &&
      typeof (parsed as { update: unknown }).update === "string"
    ) {
      return (parsed as { update: string }).update;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** `undefined` for anything that isn't a well-formed `{version, savedAt}` payload. */
function parseSnapshotEvent(
  data: string,
): { version: number; savedAt: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      "savedAt" in parsed &&
      typeof (parsed as { version: unknown }).version === "number" &&
      typeof (parsed as { savedAt: unknown }).savedAt === "number"
    ) {
      return parsed as { version: number; savedAt: number };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function docUpdateFromJoinResponse(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "docUpdate" in body &&
    typeof (body as { docUpdate: unknown }).docUpdate === "string"
  ) {
    return (body as { docUpdate: string }).docUpdate;
  }
  return undefined;
}

/** Origin tag stamped on every update `applyRemoteUpdate` applies, so the
 * doc's own `update` observer (which relays local changes to the server)
 * can tell "I made this edit" from "the server told me about someone
 * else's edit" and skip re-posting the latter — without this, every
 * remote update would round-trip back to the server as if it were new. */
const REMOTE_UPDATE_ORIGIN = "presence-remote";

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
  const doc = options.doc;

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

  function applyRemoteUpdate(base64Update: string): void {
    if (doc === undefined) return;
    try {
      Y.applyUpdate(doc, decodeBase64(base64Update), REMOTE_UPDATE_ORIGIN);
    } catch {
      // A malformed update is dropped rather than crashing the client;
      // the next join/reconnect resyncs the full doc state from scratch.
    }
  }

  let onLocalDocUpdate:
    ((update: Uint8Array, origin: unknown) => void) | undefined;
  if (doc !== undefined) {
    onLocalDocUpdate = (update, origin) => {
      if (disconnected || origin === REMOTE_UPDATE_ORIGIN) return;
      void post("update", { update: encodeBase64(update) });
    };
    doc.on("update", onLocalDocUpdate);
  }

  void post("join", { displayName: options.displayName })
    .then((response) => {
      if (doc === undefined || response === undefined || !response.ok) {
        return undefined;
      }
      return response.json();
    })
    .then((body) => {
      if (body === undefined) return;
      const docUpdate = docUpdateFromJoinResponse(body);
      if (docUpdate !== undefined) applyRemoteUpdate(docUpdate);
    })
    .catch(() => undefined);

  const source = openEventSource(`${options.roomUrl}/stream`);
  source.addEventListener("presence.state", (event) => {
    if (disconnected) return;
    notify(parseMembers(event.data));
  });
  source.addEventListener("doc.update", (event) => {
    if (disconnected) return;
    const update = parseDocUpdateEvent(event.data);
    if (update !== undefined) applyRemoteUpdate(update);
  });
  source.addEventListener("doc.saved", (event) => {
    if (disconnected) return;
    const info = parseSnapshotEvent(event.data);
    if (info !== undefined) options.onSaved?.(info);
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
      if (doc !== undefined && onLocalDocUpdate !== undefined) {
        doc.off("update", onLocalDocUpdate);
      }
      // Best-effort: the room drops this principal on its own heartbeat
      // timeout even if this never arrives (page unload racing the
      // request), so a failed leave is not a correctness bug.
      void post("leave", {});
    },
  };
}
