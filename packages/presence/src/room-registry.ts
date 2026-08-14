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

interface Room {
  readonly key: PresenceRoomKey;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly clientIdByPrincipal: Map<string, number>;
  readonly lastSeenAtByPrincipal: Map<string, number>;
  readonly listeners: Set<PresenceRoomListener>;
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
}

function roomKeyId(key: PresenceRoomKey): string {
  return `${key.tenantId}::${key.surface}`;
}

export function createPresenceRoomRegistry(): PresenceRoomRegistry {
  const rooms = new Map<string, Room>();
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

  function destroyRoomIfEmpty(key: PresenceRoomKey, room: Room): void {
    if (room.clientIdByPrincipal.size > 0 || room.listeners.size > 0) return;
    room.awareness.destroy();
    room.doc.destroy();
    rooms.delete(roomKeyId(key));
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
  };
}
