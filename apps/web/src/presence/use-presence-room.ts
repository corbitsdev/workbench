// The one place apps/web talks to `@corbits/presence/client` — every
// composition site (the channel header's who's-here stack, the canvas
// artifact pane's cursor overlay) goes through this hook rather than
// calling `connectPresence` itself, so there is exactly one connect/
// disconnect lifecycle to reason about per (tenant, surface) pair.
import { useCallback, useEffect, useRef, useState } from "react";
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
): PresenceRoom {
  const [members, setMembers] = useState<readonly PresenceRoomMember[]>([]);
  const handleRef = useRef<PresenceHandle | null>(null);

  useEffect(() => {
    setMembers([]);
    if (tenantId === null || surface === null) {
      handleRef.current = null;
      return;
    }
    const handle = connectPresence({
      roomUrl: `/api/tenants/${tenantId}/presence/rooms/${surface}`,
      ...(displayName !== undefined ? { displayName } : {}),
    });
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
  }, [tenantId, surface]);

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
