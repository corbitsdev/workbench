// The presence room registry: in-process, ephemeral awareness state for
// (tenantId, surface) rooms, backed by one `y-protocols` `Awareness`
// instance per room. Nothing here touches storage — a process restart
// simply loses presence, which is the right behavior for "who's here right
// now" — and nothing here is tenant-scoped by convention only: a room's key
// always carries the tenant id, so two tenants can never collide on the
// same `surface` string.
//
// Why an `Awareness` object at all, if the wire format between browser and
// server is plain JSON (see `./schema.ts`) rather than raw Yjs binary
// updates: this registry is deliberately the seam phase 2 (co-editing Yjs
// documents) builds on. Phase 2 adds a `Y.Doc` per room carrying real
// shared content; this phase's `Awareness` already speaks the same
// clock/meta protocol that content doc will use for cursors anchored into
// it, so upgrading later is additive, not a rewrite. See docs/presence.md.
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

export interface PresenceRoomKey {
  readonly tenantId: string;
  readonly surface: string;
}

export interface PresenceCursor {
  readonly x: number;
  readonly y: number;
  readonly surfaceVersion: number;
}

export interface PresenceState {
  readonly principalId: string;
  readonly displayName: string;
  readonly color: string;
  readonly cursor?: PresenceCursor;
  readonly typing?: boolean;
}

export type PresenceStatePatch = Partial<
  Pick<PresenceState, "cursor" | "typing">
>;

export type PresenceRoomListener = (states: readonly PresenceState[]) => void;

/** The single `Y.Text` field name every room's doc uses for co-edited
 * content. One well-known field rather than a caller-chosen name: nothing
 * about a room's `surface` string tells the registry what shape of
 * document it holds, and phase 2 only ever needs one field per room. */
export const PRESENCE_DOC_TEXT_FIELD = "content";

export type PresenceDocUpdateListener = (
  update: Uint8Array,
  authorPrincipalId: string,
) => void;

/** What a snapshot-written notification carries — enough for the UI's
 * honest "Saved · v12" line to compute its own relative-time label,
 * never a pre-formatted string the registry would have to keep re-minting. */
export interface PresenceDocSnapshotInfo {
  readonly version: number;
  readonly savedAt: number;
}

export type PresenceDocSnapshotListener = (
  info: PresenceDocSnapshotInfo,
) => void;

interface Room {
  readonly key: PresenceRoomKey;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly clientIdByPrincipal: Map<string, number>;
  readonly lastSeenAtByPrincipal: Map<string, number>;
  readonly listeners: Set<PresenceRoomListener>;
  readonly docListeners: Set<PresenceDocUpdateListener>;
  readonly snapshotListeners: Set<PresenceDocSnapshotListener>;
  /**
   * Bumped on every `join` and `applyDocUpdate`/`seedDocText` call. A
   * deferred destroy (see `destroyRoomIfEmpty`) captures this before
   * dispatching `onEmpty` and compares it again once any pending flush
   * settles — a mismatch means new membership or new content arrived
   * during the flush, so the room isn't actually stale enough to destroy
   * yet, and gets a fresh empty-check (and fresh flush) instead of being
   * torn down out from under whatever just landed on it.
   */
  epoch: number;
}

export interface PresenceRoomRegistry {
  /** Adds or replaces `state.principalId`'s state in the room, returns the room's full snapshot. */
  join(
    key: PresenceRoomKey,
    state: PresenceState,
    now?: number,
  ): readonly PresenceState[];
  /**
   * Refreshes `principalId`'s last-seen time and applies `patch` on top of
   * its existing state. Returns `undefined` if the principal never joined
   * (or was already dropped by a timeout) — the caller's signal to treat
   * this as "rejoin required" rather than a silent no-op.
   */
  heartbeat(
    key: PresenceRoomKey,
    principalId: string,
    patch: PresenceStatePatch,
    now?: number,
  ): readonly PresenceState[] | undefined;
  /** Removes `principalId` from the room and returns the resulting snapshot. */
  leave(key: PresenceRoomKey, principalId: string): readonly PresenceState[];
  /** Subscribes to every snapshot change in the room, firing once immediately with the current snapshot. */
  subscribe(key: PresenceRoomKey, listener: PresenceRoomListener): () => void;
  /** The room's current snapshot, `[]` for a room with no members (never created, or already empty). */
  states(key: PresenceRoomKey): readonly PresenceState[];
  /** Drops any principal whose last heartbeat is older than `timeoutMs`, broadcasting the change. */
  sweepStale(timeoutMs: number, now?: number): void;

  /**
   * Applies a Yjs update (already decoded from the wire's base64) to the
   * room's doc, attributing it to `authorPrincipalId` for persistence's
   * "who wrote this snapshot" bookkeeping. Unlike `join`, this never
   * creates a room: a room only exists once something has opened it
   * (`join` or a live `subscribe*`), and a write against a room nobody
   * currently holds open is exactly the "zombie" case (a stale POST
   * arriving after the room emptied and was torn down) that would
   * otherwise populate a freshly recreated, not-yet-seeded doc and
   * permanently defeat `seedOnJoin`'s "only seed an empty doc" guard.
   * Throws `PresenceRoomNotFoundError` for that case, and throws
   * (unspecified) if `update` isn't a well-formed Yjs update — the caller
   * (the HTTP route) is expected to turn either into an error response.
   *
   * This is a room-lifecycle guard, not an authorization check: it does
   * not require `authorPrincipalId` to currently be a joined member (doc
   * edits are deliberately decoupled from presence/awareness join in this
   * design). Whether `authorPrincipalId` is allowed to write at all is the
   * caller's `requireGrant` check, upstream of this call.
   */
  applyDocUpdate(
    key: PresenceRoomKey,
    update: Uint8Array,
    authorPrincipalId: string,
  ): void;
  /** The room's full doc state, encoded as one Yjs update — what a new
   * joiner applies locally to catch up. An empty (never-created) room
   * encodes to a tiny valid "empty doc" update, never an error. */
  docStateAsUpdate(key: PresenceRoomKey): Uint8Array;
  /** The current text of the room's `PRESENCE_DOC_TEXT_FIELD` field, `""` for a room with no doc content yet. */
  docText(key: PresenceRoomKey): string;
  /** Seeds the room's text field with `text`, but only if it is still
   * empty — never clobbers real content a concurrent editor already
   * wrote. Returns whether it actually seeded anything. */
  seedDocText(key: PresenceRoomKey, text: string): boolean;
  /** Subscribes to every doc update applied to the room (via `applyDocUpdate`), for relaying over SSE. */
  subscribeDocUpdates(
    key: PresenceRoomKey,
    listener: PresenceDocUpdateListener,
  ): () => void;
  /** Fires whenever any room's doc changes — the hook persistence's debounce timer schedules off. Not room-scoped: persistence watches every artifact room without knowing in advance which surfaces exist. */
  onDocChange(
    listener: (key: PresenceRoomKey, authorPrincipalId: string) => void,
  ): () => void;
  /**
   * Fires when a room is about to be torn down for having no members and
   * no SSE subscribers left — persistence's cue to flush a pending
   * snapshot immediately rather than wait out the debounce window on a
   * doc nobody is looking at anymore. A listener may return a `Promise`;
   * the registry defers the actual `Y.Doc` destruction until every
   * listener's promise has settled, so a flush that's still in flight is
   * guaranteed to see a live doc for its entire duration.
   */
  onEmpty(listener: (key: PresenceRoomKey) => void | Promise<void>): () => void;

  /**
   * Announces that a snapshot write for the room finished — persistence
   * calls this after `writeArtifactSnapshot` succeeds; the SSE route
   * relays it to every connected browser as a `doc.saved` event, which is
   * the only honest source for a "Saved · v12" line (the client itself
   * has no way to know a debounced server-side write landed otherwise).
   */
  notifySnapshot(key: PresenceRoomKey, info: PresenceDocSnapshotInfo): void;
  /** Subscribes to snapshot-written notifications for one room. */
  subscribeSnapshots(
    key: PresenceRoomKey,
    listener: PresenceDocSnapshotListener,
  ): () => void;
}

function roomKeyId(key: PresenceRoomKey): string {
  return `${key.tenantId}::${key.surface}`;
}

/** Thrown by `applyDocUpdate` for a room nobody currently holds open — see
 * that method's doc comment. Exported so a caller (e.g. the HTTP routes)
 * could map it to a distinct response instead of folding it into
 * "malformed update"; today's route still does the latter, since
 * distinguishing the two response codes is out of this change's scope. */
export class PresenceRoomNotFoundError extends Error {
  constructor(key: PresenceRoomKey) {
    super(`no open presence room for ${roomKeyId(key)}`);
    this.name = "PresenceRoomNotFoundError";
  }
}

export function createPresenceRoomRegistry(): PresenceRoomRegistry {
  const rooms = new Map<string, Room>();
  const docChangeListeners = new Set<
    (key: PresenceRoomKey, authorPrincipalId: string) => void
  >();
  const emptyListeners = new Set<
    (key: PresenceRoomKey) => void | Promise<void>
  >();
  // Room ids currently mid-teardown: their `onEmpty` listeners have fired
  // and destruction is waiting on the returned promises to settle. Guards
  // against a `leave`/`sweepStale`/unsubscribe that fires while that's
  // still in flight re-dispatching `onEmpty` a second time for the same
  // teardown — the eventual `finalize` re-checks emptiness (and, via
  // `epoch`, freshness) on its own once the first round settles.
  const pendingDestroys = new Set<string>();
  let nextClientId = 1;

  function ensureRoom(key: PresenceRoomKey): Room {
    const id = roomKeyId(key);
    let room = rooms.get(id);
    if (room === undefined) {
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      // The constructor seeds the awareness instance's own local state
      // (keyed by `doc.clientID`) with `{}` — meaningless here, since the
      // server process itself is never a room participant. Clear it so
      // `getStates()` only ever reflects real principals.
      awareness.setLocalState(null);
      room = {
        key,
        doc,
        awareness,
        clientIdByPrincipal: new Map(),
        lastSeenAtByPrincipal: new Map(),
        listeners: new Set(),
        docListeners: new Set(),
        snapshotListeners: new Set(),
        epoch: 0,
      };
      rooms.set(id, room);
    }
    return room;
  }

  function currentStates(room: Room): readonly PresenceState[] {
    return [...room.awareness.getStates().values()] as PresenceState[];
  }

  function broadcast(room: Room): void {
    const snapshot = currentStates(room);
    for (const listener of room.listeners) listener(snapshot);
  }

  /**
   * Writes `state` (or clears it, for `null`) as `clientId`'s awareness
   * state directly, bumping its clock/lastUpdated the same way the
   * library's own `setLocalState` does. This bypasses the
   * encode-then-apply round trip `y-protocols` designs for peer-to-peer
   * transport: the server here is the sole author of every client's state
   * (there is no binary update arriving over the wire to decode), so
   * writing the maps directly is the correct shortcut, not a workaround.
   */
  function writeAwarenessState(
    room: Room,
    clientId: number,
    state: PresenceState | null,
  ): void {
    const previousMeta = room.awareness.meta.get(clientId);
    const clock = previousMeta === undefined ? 0 : previousMeta.clock + 1;
    if (state === null) {
      room.awareness.states.delete(clientId);
    } else {
      room.awareness.states.set(clientId, state);
    }
    room.awareness.meta.set(clientId, { clock, lastUpdated: Date.now() });
  }

  function isRoomEmpty(room: Room): boolean {
    return room.clientIdByPrincipal.size === 0 && room.listeners.size === 0;
  }

  function destroyRoomIfEmpty(key: PresenceRoomKey, room: Room): void {
    const id = roomKeyId(key);
    // `room` may be a stale reference captured by a closure (e.g.
    // `subscribe`'s returned unsubscribe) from before the room was last
    // torn down and recreated under the same key — never act on anything
    // but the room currently registered.
    if (rooms.get(id) !== room) return;
    if (!isRoomEmpty(room)) return;
    if (pendingDestroys.has(id)) return;
    pendingDestroys.add(id);

    const epochAtDispatch = room.epoch;
    // Fired synchronously, before the doc is destroyed: a listener (e.g.
    // persistence's flush-on-empty) that reads `docText`/`doc` needs it
    // intact for the duration of this call — every synchronous read
    // within a listener sees a live doc regardless of whether it also
    // returns a promise. A returned promise defers `finalize` below, but
    // never the synchronous dispatch itself.
    const pendingFlushes = [...emptyListeners]
      .map((listener) => listener(key))
      .filter((result): result is Promise<void> => result instanceof Promise);

    const finalize = (): void => {
      pendingDestroys.delete(id);
      if (rooms.get(id) !== room) return;
      if (!isRoomEmpty(room)) return;
      if (room.epoch !== epochAtDispatch) {
        // A join or a doc/text change landed on the still-live room while
        // its flush was in flight — the room is empty again now, but with
        // content newer than what just got flushed. Re-run the whole
        // empty check so that content gets its own `onEmpty` dispatch (and
        // its own flush) instead of being silently destroyed unpersisted.
        destroyRoomIfEmpty(key, room);
        return;
      }
      room.awareness.destroy();
      room.doc.destroy();
      rooms.delete(id);
    };

    if (pendingFlushes.length === 0) {
      finalize();
    } else {
      void Promise.allSettled(pendingFlushes).then(finalize);
    }
  }

  return {
    join(key, state, now = Date.now()) {
      const room = ensureRoom(key);
      let clientId = room.clientIdByPrincipal.get(state.principalId);
      if (clientId === undefined) {
        clientId = nextClientId;
        nextClientId += 1;
        room.clientIdByPrincipal.set(state.principalId, clientId);
      }
      room.lastSeenAtByPrincipal.set(state.principalId, now);
      room.epoch += 1;
      writeAwarenessState(room, clientId, state);
      broadcast(room);
      return currentStates(room);
    },

    heartbeat(key, principalId, patch, now = Date.now()) {
      const room = rooms.get(roomKeyId(key));
      if (room === undefined) return undefined;
      const clientId = room.clientIdByPrincipal.get(principalId);
      if (clientId === undefined) return undefined;
      const previousState = room.awareness.states.get(clientId) as
        PresenceState | undefined;
      if (previousState === undefined) return undefined;
      room.lastSeenAtByPrincipal.set(principalId, now);
      writeAwarenessState(room, clientId, { ...previousState, ...patch });
      broadcast(room);
      return currentStates(room);
    },

    leave(key, principalId) {
      const room = rooms.get(roomKeyId(key));
      if (room === undefined) return [];
      const clientId = room.clientIdByPrincipal.get(principalId);
      if (clientId !== undefined) {
        writeAwarenessState(room, clientId, null);
        room.clientIdByPrincipal.delete(principalId);
        room.lastSeenAtByPrincipal.delete(principalId);
      }
      const snapshot = currentStates(room);
      broadcast(room);
      destroyRoomIfEmpty(key, room);
      return snapshot;
    },

    subscribe(key, listener) {
      const room = ensureRoom(key);
      room.listeners.add(listener);
      listener(currentStates(room));
      return () => {
        room.listeners.delete(listener);
        destroyRoomIfEmpty(key, room);
      };
    },

    states(key) {
      const room = rooms.get(roomKeyId(key));
      return room === undefined ? [] : currentStates(room);
    },

    sweepStale(timeoutMs, now = Date.now()) {
      for (const room of rooms.values()) {
        const stalePrincipalIds: string[] = [];
        for (const [principalId, lastSeenAt] of room.lastSeenAtByPrincipal) {
          if (now - lastSeenAt > timeoutMs) stalePrincipalIds.push(principalId);
        }
        if (stalePrincipalIds.length === 0) continue;
        for (const principalId of stalePrincipalIds) {
          const clientId = room.clientIdByPrincipal.get(principalId);
          if (clientId !== undefined) writeAwarenessState(room, clientId, null);
          room.clientIdByPrincipal.delete(principalId);
          room.lastSeenAtByPrincipal.delete(principalId);
        }
        broadcast(room);
        destroyRoomIfEmpty(room.key, room);
      }
    },

    applyDocUpdate(key, update, authorPrincipalId) {
      const room = rooms.get(roomKeyId(key));
      if (room === undefined) throw new PresenceRoomNotFoundError(key);
      room.epoch += 1;
      Y.applyUpdate(room.doc, update, "remote");
      for (const listener of room.docListeners) {
        listener(update, authorPrincipalId);
      }
      for (const listener of docChangeListeners) {
        listener(key, authorPrincipalId);
      }
    },

    docStateAsUpdate(key) {
      const room = rooms.get(roomKeyId(key));
      return Y.encodeStateAsUpdate(room === undefined ? new Y.Doc() : room.doc);
    },

    docText(key) {
      const room = rooms.get(roomKeyId(key));
      if (room === undefined) return "";
      return room.doc.getText(PRESENCE_DOC_TEXT_FIELD).toString();
    },

    seedDocText(key, text) {
      const room = ensureRoom(key);
      const yText = room.doc.getText(PRESENCE_DOC_TEXT_FIELD);
      if (yText.length > 0) return false;
      room.epoch += 1;
      yText.insert(0, text);
      return true;
    },

    subscribeDocUpdates(key, listener) {
      const room = ensureRoom(key);
      room.docListeners.add(listener);
      return () => {
        room.docListeners.delete(listener);
      };
    },

    onDocChange(listener) {
      docChangeListeners.add(listener);
      return () => {
        docChangeListeners.delete(listener);
      };
    },

    onEmpty(listener) {
      emptyListeners.add(listener);
      return () => {
        emptyListeners.delete(listener);
      };
    },

    notifySnapshot(key, info) {
      const room = rooms.get(roomKeyId(key));
      if (room === undefined) return;
      for (const listener of room.snapshotListeners) listener(info);
    },

    subscribeSnapshots(key, listener) {
      const room = ensureRoom(key);
      room.snapshotListeners.add(listener);
      return () => {
        room.snapshotListeners.delete(listener);
      };
    },
  };
}
