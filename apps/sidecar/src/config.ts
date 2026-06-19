// Sidecar heartbeat tuning. The hub link declares its connection dead only
// after 2 x pingIntervalMs of missed pongs (see @intx/hub-agent hub-link).
// The upstream default of 30s means a hard hub kill (Railway container swap,
// which sends no clean close frame) leaves the sidecar holding a zombie
// socket for up to 60s before it redials. The hub redeploys on every merge,
// so we tighten detection to ~10s and redial fast. These are operational
// tunables with safe defaults — overridable via env when an environment
// needs different timing.

import path from 'node:path';

const DEFAULT_PING_INTERVAL_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;

// Content-addressable tarball cache for materialized tool packages.
// 512 MiB holds many deduped tool-package extractions; 64 MiB caps any
// single registry tarball fetch. Both overridable for tighter environments.
const DEFAULT_TOOL_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_REGISTRY_MAX_TARBALL_BYTES = 64 * 1024 * 1024;

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

export type ToolPackageCache = {
  cacheRoot: string;
  cacheMaxBytes: number;
  registryMaxTarballBytes: number;
};

export function resolveToolPackageCache(
  env: Record<string, string | undefined>,
  dataDir: string
): ToolPackageCache {
  const cacheRoot = env.SIDECAR_TOOL_CACHE_DIR ?? path.join(dataDir, 'cache', 'tool-packages');
  return {
    cacheRoot,
    cacheMaxBytes: parsePositiveInt(
      'SIDECAR_TOOL_CACHE_MAX_BYTES',
      env.SIDECAR_TOOL_CACHE_MAX_BYTES,
      DEFAULT_TOOL_CACHE_MAX_BYTES
    ),
    registryMaxTarballBytes: parsePositiveInt(
      'SIDECAR_REGISTRY_MAX_TARBALL_BYTES',
      env.SIDECAR_REGISTRY_MAX_TARBALL_BYTES,
      DEFAULT_REGISTRY_MAX_TARBALL_BYTES
    ),
  };
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
