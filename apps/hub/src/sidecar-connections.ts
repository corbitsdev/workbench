// Tracks open sidecar websocket connections so graceful shutdown can close
// them deliberately. Without this, the hub's SIGTERM handler exits without
// sending close frames, so a redeploy looks identical to a hard kill from the
// sidecar's side: it holds a zombie socket until its heartbeat times out
// (~60s upstream, ~10s after CL-1654) before redialing. Closing the sockets
// here lets the sidecar reconnect on its short reconnect delay instead.

export type SidecarConnection = {
  close(): void;
};

export type SidecarConnectionRegistry = {
  track(connection: SidecarConnection): void;
  untrack(connection: SidecarConnection): void;
  closeAll(): void;
  size(): number;
};

export function createSidecarConnectionRegistry(): SidecarConnectionRegistry {
  const connections = new Set<SidecarConnection>();

  return {
    track(connection) {
      connections.add(connection);
    },
    untrack(connection) {
      connections.delete(connection);
    },
    closeAll() {
      // Best-effort: one socket that throws on close must not prevent the
      // rest from being closed during shutdown.
      for (const connection of connections) {
        try {
          connection.close();
        } catch {
          // Already-closing sockets can throw; nothing actionable at exit.
        }
      }
      connections.clear();
    },
    size() {
      return connections.size;
    },
  };
}
