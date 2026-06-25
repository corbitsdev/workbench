// Sidecar heartbeat tuning. The hub link declares its connection dead only
// after 2 x pingIntervalMs of missed pongs (see @intx/hub-agent hub-link).
// The upstream default of 30s means a hard hub kill (Railway container swap,
// which sends no clean close frame) leaves the sidecar holding a zombie
// socket for up to 60s before it redials. The hub redeploys on every merge,
// so we tighten detection to ~10s and redial fast. These are operational
// tunables with safe defaults — overridable via env when an environment
// needs different timing.

import path from "node:path";

const DEFAULT_PING_INTERVAL_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;

// Content-addressable tarball cache for materialized tool packages.
// 512 MiB holds many deduped tool-package extractions; 64 MiB caps any
// single registry tarball fetch. Both overridable for tighter environments.
export const DEFAULT_TOOL_CACHE_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_REGISTRY_MAX_TARBALL_BYTES = 64 * 1024 * 1024;

export type SidecarHeartbeat = {
  pingIntervalMs: number;
  reconnectDelayMs: number;
};

export type SidecarHubLinkQueue = {
  maxOutboundQueue: number;
};

const DEFAULT_MAX_OUTBOUND_QUEUE = 4096;

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
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
  dataDir: string,
): ToolPackageCache {
  const cacheRoot =
    env.SIDECAR_TOOL_CACHE_DIR ?? path.join(dataDir, "cache", "tool-packages");
  return {
    cacheRoot,
    cacheMaxBytes: parsePositiveInt(
      "SIDECAR_TOOL_CACHE_MAX_BYTES",
      env.SIDECAR_TOOL_CACHE_MAX_BYTES,
      DEFAULT_TOOL_CACHE_MAX_BYTES,
    ),
    registryMaxTarballBytes: parsePositiveInt(
      "SIDECAR_REGISTRY_MAX_TARBALL_BYTES",
      env.SIDECAR_REGISTRY_MAX_TARBALL_BYTES,
      DEFAULT_REGISTRY_MAX_TARBALL_BYTES,
    ),
  };
}

export function resolveSidecarHeartbeat(
  env: Record<string, string | undefined>,
): SidecarHeartbeat {
  return {
    pingIntervalMs: parsePositiveInt(
      "SIDECAR_PING_INTERVAL_MS",
      env.SIDECAR_PING_INTERVAL_MS,
      DEFAULT_PING_INTERVAL_MS,
    ),
    reconnectDelayMs: parsePositiveInt(
      "SIDECAR_RECONNECT_DELAY_MS",
      env.SIDECAR_RECONNECT_DELAY_MS,
      DEFAULT_RECONNECT_DELAY_MS,
    ),
  };
}

export function resolveSidecarHubLinkQueue(
  env: Record<string, string | undefined>,
): SidecarHubLinkQueue {
  return {
    maxOutboundQueue: parsePositiveInt(
      "SIDECAR_HUB_LINK_MAX_OUTBOUND_QUEUE",
      env.SIDECAR_HUB_LINK_MAX_OUTBOUND_QUEUE,
      DEFAULT_MAX_OUTBOUND_QUEUE,
    ),
  };
}

// Workflow-run pack-push safety ceiling. A wedged or looping run appends one
// commit per event without bound; the pack builder walks that chain and
// materializes every reachable object into a single in-memory buffer. Left
// uncapped, a runaway run exhausts the sidecar heap and the kernel OOM-kills
// the whole process — evicting every co-resident deployment, not just the
// offending run (CL-2340). These ceilings fail the offending run loudly
// instead. Generous over any real run; overridable for tighter environments.
export const DEFAULT_WORKFLOW_RUN_PACK_MAX_COMMITS = 10_000;
export const DEFAULT_WORKFLOW_RUN_PACK_MAX_OBJECTS = 500_000;

export type WorkflowRunPackLimits = {
  maxCommits: number;
  maxObjects: number;
};

export function resolveWorkflowRunPackLimits(
  env: Record<string, string | undefined>,
): WorkflowRunPackLimits {
  return {
    maxCommits: parsePositiveInt(
      "SIDECAR_WORKFLOW_RUN_PACK_MAX_COMMITS",
      env.SIDECAR_WORKFLOW_RUN_PACK_MAX_COMMITS,
      DEFAULT_WORKFLOW_RUN_PACK_MAX_COMMITS,
    ),
    maxObjects: parsePositiveInt(
      "SIDECAR_WORKFLOW_RUN_PACK_MAX_OBJECTS",
      env.SIDECAR_WORKFLOW_RUN_PACK_MAX_OBJECTS,
      DEFAULT_WORKFLOW_RUN_PACK_MAX_OBJECTS,
    ),
  };
}
