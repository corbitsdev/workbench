// A workbench's live "who's here" roster — the piggyback idiom
// `chat.typing` already established (an ephemeral event on the same SSE
// stream, never a durable row) extended to presence. Membership tracks
// open SSE connections directly (see `bridgeWorkbenchStream`'s
// `presence` option): a principal is "here" exactly as long as it has
// at least one open `/workbenches/:id/stream` connection, no HTTP
// heartbeat poll required. `lastActiveAt` still needs an explicit
// refresh — a connection can sit open for hours with the tab
// backgrounded — which `POST /workbenches/:id/presence` provides, the
// same idiom `POST /workbenches/:id/typing` already uses for its own
// ping.
//
// In-process only, matching `WorkbenchSubscriberRegistry`: a multi-node
// deployment fans this out exactly as far as the SSE registry itself
// fans out, no further — an acceptable, disclosed scope match for a
// feature whose entire premise is "derived from this process's own live
// connections."
export interface PresenceMember {
  readonly principalId: string;
  readonly lastActiveAt: string;
}

export interface WorkbenchPresenceRegistry {
  /**
   * Registers one more live connection for `principalId` on
   * `workbenchId` and stamps its `lastActiveAt`. A principal with
   * multiple open tabs/connections is one ref-counted membership, not
   * one member per connection.
   */
  connect(workbenchId: string, principalId: string, now?: number): void;
  /**
   * Releases one live connection. Returns `true` exactly when this was
   * the principal's last open connection on this workbench — the
   * caller's cue to broadcast an `"offline"` delta rather than a
   * spurious one for every closed tab while others stay open.
   */
  disconnect(workbenchId: string, principalId: string): boolean;
  /** Refreshes `lastActiveAt` for an already-connected principal without
   * changing its connection count. A no-op for a principal with no open
   * connection on this workbench — a stream that already closed. */
  ping(workbenchId: string, principalId: string, now?: number): void;
  /** The current roster, oldest-connected-first is not guaranteed —
   * callers needing an order sort it themselves. `[]` for a workbench
   * with nobody connected. */
  snapshot(workbenchId: string): readonly PresenceMember[];
}

interface Membership {
  connections: number;
  lastActiveAt: number;
}

export function createWorkbenchPresenceRegistry(): WorkbenchPresenceRegistry {
  const byWorkbench = new Map<string, Map<string, Membership>>();

  function membersOf(workbenchId: string): Map<string, Membership> {
    let members = byWorkbench.get(workbenchId);
    if (members === undefined) {
      members = new Map();
      byWorkbench.set(workbenchId, members);
    }
    return members;
  }

  return {
    connect(workbenchId, principalId, now = Date.now()) {
      const members = membersOf(workbenchId);
      const existing = members.get(principalId);
      members.set(principalId, {
        connections: (existing?.connections ?? 0) + 1,
        lastActiveAt: now,
      });
    },

    disconnect(workbenchId, principalId) {
      const members = byWorkbench.get(workbenchId);
      const existing = members?.get(principalId);
      if (members === undefined || existing === undefined) return false;
      if (existing.connections <= 1) {
        members.delete(principalId);
        if (members.size === 0) byWorkbench.delete(workbenchId);
        return true;
      }
      members.set(principalId, {
        connections: existing.connections - 1,
        lastActiveAt: existing.lastActiveAt,
      });
      return false;
    },

    ping(workbenchId, principalId, now = Date.now()) {
      const members = byWorkbench.get(workbenchId);
      const existing = members?.get(principalId);
      if (members === undefined || existing === undefined) return;
      members.set(principalId, { ...existing, lastActiveAt: now });
    },

    snapshot(workbenchId) {
      const members = byWorkbench.get(workbenchId);
      if (members === undefined) return [];
      return [...members.entries()].map(([principalId, membership]) => ({
        principalId,
        lastActiveAt: new Date(membership.lastActiveAt).toISOString(),
      }));
    },
  };
}
