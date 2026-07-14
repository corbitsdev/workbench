import { describe, it, expect, afterEach } from "bun:test";
import path from "node:path";
import {
  readAdapterManifest,
  resolveAgentGCPolicy,
  resolveSidecarBuildTimeoutMs,
  resolveSidecarHeartbeat,
  resolveSidecarIdleEviction,
  resolveToolPackageCache,
  resolveWorkflowRunPackLimits,
} from "./config";

describe("resolveSidecarIdleEviction", () => {
  it("defaults to a 60s threshold with a bounded sweep cadence", () => {
    const cfg = resolveSidecarIdleEviction({});
    expect(cfg.idleEvictMs).toBe(60_000);
    // Sweep is clamped to at most 15s so eviction latency tracks the threshold.
    expect(cfg.sweepIntervalMs).toBe(15_000);
  });

  it("treats 0 as disabled and yields a 0 sweep interval", () => {
    const cfg = resolveSidecarIdleEviction({
      SIDECAR_AGENT_IDLE_EVICT_MS: "0",
    });
    expect(cfg.idleEvictMs).toBe(0);
    expect(cfg.sweepIntervalMs).toBe(0);
  });

  it("derives the sweep cadence from a small threshold", () => {
    const cfg = resolveSidecarIdleEviction({
      SIDECAR_AGENT_IDLE_EVICT_MS: "4000",
    });
    expect(cfg.idleEvictMs).toBe(4_000);
    expect(cfg.sweepIntervalMs).toBe(4_000);
  });

  it("floors the sweep cadence for a very small threshold", () => {
    const cfg = resolveSidecarIdleEviction({
      SIDECAR_AGENT_IDLE_EVICT_MS: "200",
    });
    expect(cfg.idleEvictMs).toBe(200);
    expect(cfg.sweepIntervalMs).toBe(1_000);
  });

  it("rejects a negative threshold", () => {
    expect(() =>
      resolveSidecarIdleEviction({ SIDECAR_AGENT_IDLE_EVICT_MS: "-1" }),
    ).toThrow(/non-negative integer/);
  });

  it("rejects a non-integer threshold", () => {
    expect(() =>
      resolveSidecarIdleEviction({ SIDECAR_AGENT_IDLE_EVICT_MS: "abc" }),
    ).toThrow(/non-negative integer/);
  });
});

describe("resolveSidecarBuildTimeoutMs", () => {
  it("defaults to a 3-minute wedge-guard bound", () => {
    expect(resolveSidecarBuildTimeoutMs({})).toBe(180_000);
  });

  it("honors an override", () => {
    expect(
      resolveSidecarBuildTimeoutMs({
        SIDECAR_HARNESS_BUILD_TIMEOUT_MS: "30000",
      }),
    ).toBe(30_000);
  });

  it("treats 0 as disabling the bound", () => {
    expect(
      resolveSidecarBuildTimeoutMs({ SIDECAR_HARNESS_BUILD_TIMEOUT_MS: "0" }),
    ).toBe(0);
  });

  it("rejects a negative value", () => {
    expect(() =>
      resolveSidecarBuildTimeoutMs({ SIDECAR_HARNESS_BUILD_TIMEOUT_MS: "-1" }),
    ).toThrow(/non-negative integer/);
  });

  it("rejects a non-integer value", () => {
    expect(() =>
      resolveSidecarBuildTimeoutMs({ SIDECAR_HARNESS_BUILD_TIMEOUT_MS: "abc" }),
    ).toThrow(/non-negative integer/);
  });
});

describe("resolveSidecarHeartbeat", () => {
  it("uses fast defaults when env is unset", () => {
    const hb = resolveSidecarHeartbeat({});
    expect(hb.pingIntervalMs).toBe(5_000);
    expect(hb.reconnectDelayMs).toBe(1_000);
    expect(hb.maxReconnectDelayMs).toBe(3_000);
  });

  it("overrides from env when provided", () => {
    const hb = resolveSidecarHeartbeat({
      SIDECAR_PING_INTERVAL_MS: "2000",
      SIDECAR_RECONNECT_DELAY_MS: "500",
      SIDECAR_MAX_RECONNECT_DELAY_MS: "8000",
    });
    expect(hb.pingIntervalMs).toBe(2_000);
    expect(hb.reconnectDelayMs).toBe(500);
    expect(hb.maxReconnectDelayMs).toBe(8_000);
  });

  it("rejects a non-integer override", () => {
    expect(() =>
      resolveSidecarHeartbeat({ SIDECAR_PING_INTERVAL_MS: "soon" }),
    ).toThrow(
      'SIDECAR_PING_INTERVAL_MS must be a positive integer (got "soon")',
    );
  });

  it("rejects a non-positive override", () => {
    expect(() =>
      resolveSidecarHeartbeat({ SIDECAR_RECONNECT_DELAY_MS: "0" }),
    ).toThrow(
      'SIDECAR_RECONNECT_DELAY_MS must be a positive integer (got "0")',
    );
  });
});

describe("resolveToolPackageCache", () => {
  it("defaults the cache root under the data dir", () => {
    const cache = resolveToolPackageCache({}, "/var/sidecar");
    expect(cache.cacheRoot).toBe(
      path.join("/var/sidecar", "cache", "tool-packages"),
    );
    expect(cache.cacheMaxBytes).toBeGreaterThan(0);
    expect(cache.registryMaxTarballBytes).toBeGreaterThan(0);
  });

  it("honors an explicit cache dir and byte caps", () => {
    const cache = resolveToolPackageCache(
      {
        SIDECAR_TOOL_CACHE_DIR: "/mnt/cache",
        SIDECAR_TOOL_CACHE_MAX_BYTES: "1024",
        SIDECAR_REGISTRY_MAX_TARBALL_BYTES: "512",
      },
      "/var/sidecar",
    );
    expect(cache.cacheRoot).toBe("/mnt/cache");
    expect(cache.cacheMaxBytes).toBe(1024);
    expect(cache.registryMaxTarballBytes).toBe(512);
  });

  it("rejects a non-positive byte cap", () => {
    expect(() =>
      resolveToolPackageCache({ SIDECAR_TOOL_CACHE_MAX_BYTES: "0" }, "/d"),
    ).toThrow();
  });
});

describe("resolveWorkflowRunPackLimits", () => {
  it("uses generous defaults when env is unset", () => {
    const limits = resolveWorkflowRunPackLimits({});
    expect(limits.maxCommits).toBe(10_000);
    expect(limits.maxObjects).toBe(500_000);
  });

  it("overrides both ceilings from env when provided", () => {
    const limits = resolveWorkflowRunPackLimits({
      SIDECAR_WORKFLOW_RUN_PACK_MAX_COMMITS: "250",
      SIDECAR_WORKFLOW_RUN_PACK_MAX_OBJECTS: "5000",
    });
    expect(limits.maxCommits).toBe(250);
    expect(limits.maxObjects).toBe(5_000);
  });

  it("rejects a non-positive commit ceiling", () => {
    expect(() =>
      resolveWorkflowRunPackLimits({
        SIDECAR_WORKFLOW_RUN_PACK_MAX_COMMITS: "0",
      }),
    ).toThrow(
      'SIDECAR_WORKFLOW_RUN_PACK_MAX_COMMITS must be a positive integer (got "0")',
    );
  });

  it("rejects a non-integer object ceiling", () => {
    expect(() =>
      resolveWorkflowRunPackLimits({
        SIDECAR_WORKFLOW_RUN_PACK_MAX_OBJECTS: "lots",
      }),
    ).toThrow(
      'SIDECAR_WORKFLOW_RUN_PACK_MAX_OBJECTS must be a positive integer (got "lots")',
    );
  });
});

describe("resolveAgentGCPolicy", () => {
  it("uses the upstream sidecar defaults when env is unset", () => {
    expect(resolveAgentGCPolicy({})).toEqual({
      packThreshold: 16,
      looseThreshold: 512,
      warnBytes: 128 * 1024 * 1024,
      retention: "tip-only",
    });
  });

  it("overrides thresholds and retention from env", () => {
    expect(
      resolveAgentGCPolicy({
        SIDECAR_AGENT_GC_PACK_THRESHOLD: "4",
        SIDECAR_AGENT_GC_LOOSE_THRESHOLD: "100",
        SIDECAR_AGENT_GC_WARN_BYTES: "2048",
        SIDECAR_AGENT_GC_RETENTION: "keep-history",
      }),
    ).toEqual({
      packThreshold: 4,
      looseThreshold: 100,
      warnBytes: 2048,
      retention: "keep-history",
    });
  });

  it("rejects a non-positive threshold", () => {
    expect(() =>
      resolveAgentGCPolicy({ SIDECAR_AGENT_GC_PACK_THRESHOLD: "0" }),
    ).toThrow(
      'SIDECAR_AGENT_GC_PACK_THRESHOLD must be a positive integer (got "0")',
    );
  });

  it("rejects an unknown retention value", () => {
    expect(() =>
      resolveAgentGCPolicy({ SIDECAR_AGENT_GC_RETENTION: "forever" }),
    ).toThrow(
      'SIDECAR_AGENT_GC_RETENTION must be "tip-only" or "keep-history"; got "forever"',
    );
  });
});

// Boot-edge deserialization boundary for the operator adapter manifest. The
// parse itself is shared with the child boundary (`parseAdapterManifest`);
// these pin the boot-edge contract: the unset/blank default and the env-var
// error context.
describe("readAdapterManifest", () => {
  const KEY = "SIDECAR_ADAPTER_MANIFEST";
  const saved = process.env[KEY];

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = saved;
    }
  });

  it("returns the empty manifest when unset or whitespace-only", () => {
    delete process.env[KEY];
    expect(readAdapterManifest()).toEqual([]);
    process.env[KEY] = "   ";
    expect(readAdapterManifest()).toEqual([]);
  });

  it("parses a valid manifest", () => {
    const manifest = [
      { provider: "acme", specifier: "@acme/adapter", export: "createAdapter" },
    ];
    process.env[KEY] = JSON.stringify(manifest);
    expect(readAdapterManifest()).toEqual(manifest);
  });

  it("throws loudly on malformed JSON, naming the env var", () => {
    process.env[KEY] = "{not json";
    expect(() => readAdapterManifest()).toThrow(
      /SIDECAR_ADAPTER_MANIFEST environment variable is invalid:.*not valid JSON/s,
    );
  });

  it("throws with the validation summary on a schema-violating entry", () => {
    process.env[KEY] = JSON.stringify([{ provider: "acme" }]);
    expect(() => readAdapterManifest()).toThrow(
      /SIDECAR_ADAPTER_MANIFEST environment variable is invalid:.*specifier/s,
    );
  });
});
