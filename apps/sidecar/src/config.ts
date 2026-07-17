// Sidecar heartbeat tuning. The hub link declares its connection dead only
// after 2 x pingIntervalMs of missed pongs (see @intx/hub-agent hub-link).
// The upstream default of 30s means a hard hub kill (Railway container swap,
// which sends no clean close frame) leaves the sidecar holding a zombie
// socket for up to 60s before it redials. The hub redeploys on every merge,
// so we tighten detection to ~10s and redial fast. These are operational
// tunables with safe defaults — overridable via env when an environment
// needs different timing.

import path from "node:path";

import type { AdapterManifest } from "@intx/inference";
import type { GCPolicy, RetentionPolicy } from "@workbench/storage-isogit";

import { parseAdapterManifest } from "./workflow-substrate-factory";

const DEFAULT_PING_INTERVAL_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
// Backoff ceiling. reconnectDelayMs is the floor; the hub link grows the
// delay exponentially from it toward this cap (with jitter) so a hub that
// stays down is retried without a tight hammer loop, while a brief
// redeploy blip still reconnects within the floor.
const DEFAULT_MAX_RECONNECT_DELAY_MS = 3_000;
// WORKBENCH-LOCAL (CL-3826): per-attempt connect timeout. Bounds how long a
// single connect attempt waits for `open` before the hub-link abandons it and
// retries on the backoff above, so a TCP connect that blackholes (Railway
// routing to a draining replica during a redeploy overlap window) does not
// stall reconnection for the whole overlap window.
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

// Content-addressable tarball cache for materialized tool packages.
// 512 MiB holds many deduped tool-package extractions; 64 MiB caps any
// single registry tarball fetch. Both overridable for tighter environments.
export const DEFAULT_TOOL_CACHE_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_REGISTRY_MAX_TARBALL_BYTES = 64 * 1024 * 1024;

export type SidecarHeartbeat = {
  pingIntervalMs: number;
  reconnectDelayMs: number;
  maxReconnectDelayMs: number;
  // WORKBENCH-LOCAL (CL-3826)
  connectTimeoutMs: number;
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

// A non-negative integer where 0 is a meaningful "disabled" value, unlike
// `parsePositiveInt` which rejects 0. Used by the idle-eviction threshold.
function parseNonNegativeInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return value;
}

// Idle-agent eviction (CL-3103). A live agent session with no activity for
// `idleEvictMs` is torn down and returned to the wakeable state; the next
// inbound message rebuilds it with full history from the durable repo store.
// Default 60s; `0` disables eviction. The sweep runs on a fixed cadence
// derived from the threshold (bounded so a large threshold still sweeps
// often enough that eviction latency stays close to the threshold).
export const DEFAULT_SIDECAR_AGENT_IDLE_EVICT_MS = 60_000;
const IDLE_EVICT_SWEEP_MIN_MS = 1_000;
const IDLE_EVICT_SWEEP_MAX_MS = 15_000;

export type SidecarIdleEviction = {
  idleEvictMs: number;
  sweepIntervalMs: number;
};

export function resolveSidecarIdleEviction(
  env: Record<string, string | undefined>,
): SidecarIdleEviction {
  const idleEvictMs = parseNonNegativeInt(
    "SIDECAR_AGENT_IDLE_EVICT_MS",
    env.SIDECAR_AGENT_IDLE_EVICT_MS,
    DEFAULT_SIDECAR_AGENT_IDLE_EVICT_MS,
  );
  const sweepIntervalMs =
    idleEvictMs <= 0
      ? 0
      : Math.min(
          IDLE_EVICT_SWEEP_MAX_MS,
          Math.max(IDLE_EVICT_SWEEP_MIN_MS, idleEvictMs),
        );
  return { idleEvictMs, sweepIntervalMs };
}

// Harness-build wedge guard. A single agent's harness build that never settles
// (an isogit per-directory lock the build waits on, a stalled tool/credential
// fetch, a wedged context-store load for a long-history agent) otherwise pins
// the wake in flight forever: the hub's session.start ack times out with no
// diagnostic and the agent is unreachable until the sidecar restarts. This
// bound abandons the wedged build and fails the attempt loudly. Default 3
// minutes — generous over any real cold build; `0` disables the bound.
export const DEFAULT_SIDECAR_HARNESS_BUILD_TIMEOUT_MS = 180_000;

export function resolveSidecarBuildTimeoutMs(
  env: Record<string, string | undefined>,
): number {
  return parseNonNegativeInt(
    "SIDECAR_HARNESS_BUILD_TIMEOUT_MS",
    env.SIDECAR_HARNESS_BUILD_TIMEOUT_MS,
    DEFAULT_SIDECAR_HARNESS_BUILD_TIMEOUT_MS,
  );
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
    maxReconnectDelayMs: parsePositiveInt(
      "SIDECAR_MAX_RECONNECT_DELAY_MS",
      env.SIDECAR_MAX_RECONNECT_DELAY_MS,
      DEFAULT_MAX_RECONNECT_DELAY_MS,
    ),
    // WORKBENCH-LOCAL (CL-3826)
    connectTimeoutMs: parsePositiveInt(
      "SIDECAR_CONNECT_TIMEOUT_MS",
      env.SIDECAR_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
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

// Write-path GC for the sidecar's deployed-agent repos (mirrors the
// upstream reference sidecar's `readAgentGCPolicy`). The reactor
// commits loose objects every cycle, so these repos accumulate loose
// objects far faster than packs; the loose threshold is the dominant
// trigger here. Retention defaults to tip-only: the sidecar treats the
// repo as the agent's current state, not a long-term archive, so dropping
// commit history keeps the repo small for reactor read/commit latency. An
// operator that needs the history preserved sets
// SIDECAR_AGENT_GC_RETENTION=keep-history.
export const DEFAULT_SIDECAR_AGENT_GC_PACK_THRESHOLD = 16;
export const DEFAULT_SIDECAR_AGENT_GC_LOOSE_THRESHOLD = 512;
export const DEFAULT_SIDECAR_AGENT_GC_WARN_BYTES = 128 * 1024 * 1024;

function parseRetention(
  name: string,
  raw: string | undefined,
  fallback: RetentionPolicy,
): RetentionPolicy {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "tip-only" || raw === "keep-history") return raw;
  throw new Error(
    `${name} must be "tip-only" or "keep-history"; got ${JSON.stringify(raw)}`,
  );
}

export function resolveAgentGCPolicy(
  env: Record<string, string | undefined>,
): GCPolicy {
  return {
    packThreshold: parsePositiveInt(
      "SIDECAR_AGENT_GC_PACK_THRESHOLD",
      env.SIDECAR_AGENT_GC_PACK_THRESHOLD,
      DEFAULT_SIDECAR_AGENT_GC_PACK_THRESHOLD,
    ),
    looseThreshold: parsePositiveInt(
      "SIDECAR_AGENT_GC_LOOSE_THRESHOLD",
      env.SIDECAR_AGENT_GC_LOOSE_THRESHOLD,
      DEFAULT_SIDECAR_AGENT_GC_LOOSE_THRESHOLD,
    ),
    warnBytes: parsePositiveInt(
      "SIDECAR_AGENT_GC_WARN_BYTES",
      env.SIDECAR_AGENT_GC_WARN_BYTES,
      DEFAULT_SIDECAR_AGENT_GC_WARN_BYTES,
    ),
    retention: parseRetention(
      "SIDECAR_AGENT_GC_RETENTION",
      env.SIDECAR_AGENT_GC_RETENTION,
      "tip-only",
    ),
  };
}

// Operator-configured custom inference adapter manifest (mirrors the
// upstream reference sidecar's `readAdapterManifest`). The value is
// TRUSTED operator input read only from this process's environment;
// `import(specifier)` is arbitrary code execution, so a specifier must
// never originate from deploy or tenant data — the agent deploy tree
// carries only a `provider` key, never a specifier.
//
// Unset or whitespace-only means "no custom adapters", a valid
// configuration — the sidecar then resolves only the statically-linked
// built-ins. A present-but-malformed value fails loud at boot.
export function readAdapterManifest(): AdapterManifest {
  const raw = process.env["SIDECAR_ADAPTER_MANIFEST"];
  if (raw === undefined || raw.trim() === "") return [];
  try {
    return parseAdapterManifest(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `SIDECAR_ADAPTER_MANIFEST environment variable is invalid: ${reason}`,
      { cause },
    );
  }
}
