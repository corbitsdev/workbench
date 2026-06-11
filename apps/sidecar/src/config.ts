// Sidecar heartbeat tuning. The hub link declares its connection dead only
// after 2 x pingIntervalMs of missed pongs (see @intx/hub-agent hub-link).
// The upstream default of 30s means a hard hub kill (Railway container swap,
// which sends no clean close frame) leaves the sidecar holding a zombie
// socket for up to 60s before it redials. The hub redeploys on every merge,
// so we tighten detection to ~10s and redial fast. These are operational
// tunables with safe defaults — overridable via env when an environment
// needs different timing.

const DEFAULT_PING_INTERVAL_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;

export type SidecarHeartbeat = {
  pingIntervalMs: number;
  reconnectDelayMs: number;
};

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

export function resolveSidecarHeartbeat(env: Record<string, string | undefined>): SidecarHeartbeat {
  return {
    pingIntervalMs: parsePositiveInt(
      'SIDECAR_PING_INTERVAL_MS',
      env.SIDECAR_PING_INTERVAL_MS,
      DEFAULT_PING_INTERVAL_MS
    ),
    reconnectDelayMs: parsePositiveInt(
      'SIDECAR_RECONNECT_DELAY_MS',
      env.SIDECAR_RECONNECT_DELAY_MS,
      DEFAULT_RECONNECT_DELAY_MS
    ),
  };
}
