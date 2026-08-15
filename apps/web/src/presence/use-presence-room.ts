// The one place apps/web talks to `@corbits/presence/client` — every
// composition site (the channel header's who's-here stack, the canvas
// artifact pane's cursor overlay) goes through this hook rather than
// calling `connectPresence` itself, so there is exactly one connect/
// disconnect lifecycle to reason about per (tenant, surface) pair.
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { connectPresence, type PresenceHandle } from "@corbits/presence/client";

export interface PresenceRoomMember {
  readonly principalId: string;
  readonly displayName: string;
  readonly color: string;
  readonly cursor?: {
    readonly x: number;
    readonly y: number;
    readonly surfaceVersion: number;
  };
  readonly typing?: boolean;
}

export interface PresenceRoom {
  readonly members: readonly PresenceRoomMember[];
  readonly publishCursor: (
    x: number,
    y: number,
    surfaceVersion?: number,
  ) => void;
  readonly publishTyping: (typing: boolean) => void;
}

export interface UsePresenceRoomOptions {
  /**
   * A shared `Y.Doc` to keep in sync over this room — see
   * `@corbits/presence/client`'s own `doc` option. Only artifact rooms
   * (CL-5958 phase 2 co-editing) pass this; the channel who's-here stack
   * never does, since it has no doc content. Reconnects when the `Y.Doc`
   * instance itself changes (a different artifact), not on every render.
   */
  readonly doc?: Y.Doc;
  /** Called for every confirmed server-side snapshot — see `formatSaveStateLine` in `@corbits/artifact-ui`. */
  readonly onSaved?: (info: { version: number; savedAt: number }) => void;
}

/**
 * Connects to a presence room for as long as `tenantId`/`surface` are both
 * present, tearing down and reconnecting whenever either changes (channel
 * switch, artifact switch, workbench switch). `null` for either means
 * "nothing to connect to" — mirrors `useChannelStream`'s empty-url guard in
 * `@corbits/chat-ui`.
 */
export function usePresenceRoom(
  tenantId: string | null,
  surface: string | null,
  displayName?: string,
  options?: UsePresenceRoomOptions,
): PresenceRoom {
  const [members, setMembers] = useState<readonly PresenceRoomMember[]>([]);
  const handleRef = useRef<PresenceHandle | null>(null);
  // `onSaved` is read through a ref, not a `connectPresence` dependency:
  // a caller re-rendering with a fresh inline callback must never tear
  // down and reconnect the stream (it would re-fetch the whole doc state
  // for no reason) — only the `Y.Doc` identity changing means a genuinely
  // different room to sync.
  const onSavedRef = useRef(options?.onSaved);
  onSavedRef.current = options?.onSaved;
  const doc = options?.doc;

  useEffect(() => {
    setMembers([]);
    if (tenantId === null || surface === null) {
      handleRef.current = null;
      return;
    }
    const connectOptions: {
      roomUrl: string;
      onSaved: (info: { version: number; savedAt: number }) => void;
      displayName?: string;
      doc?: Y.Doc;
    } = {
      roomUrl: `/api/tenants/${tenantId}/presence/rooms/${surface}`,
      onSaved: (info) => onSavedRef.current?.(info),
    };
    if (displayName !== undefined) connectOptions.displayName = displayName;
    if (doc !== undefined) connectOptions.doc = doc;
    const handle = connectPresence(connectOptions);
    handleRef.current = handle;
    const unsubscribe = handle.subscribe((snapshot) =>
      setMembers(snapshot as readonly PresenceRoomMember[]),
    );
    return () => {
      unsubscribe();
      handle.disconnect();
      handleRef.current = null;
    };
    // `displayName` deliberately isn't a dependency: a later rename
    // shouldn't tear down and reconnect an otherwise-unaffected stream.
  }, [tenantId, surface, doc]);

  const publishCursor = useCallback(
    (x: number, y: number, surfaceVersion = 1) => {
      handleRef.current?.publishCursor({ x, y, surfaceVersion });
    },
    [],
  );

  const publishTyping = useCallback((typing: boolean) => {
    handleRef.current?.publishTyping(typing);
  }, []);

  return { members, publishCursor, publishTyping };
}
