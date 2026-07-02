import { describe, it, expect } from "bun:test";
import path from "node:path";
import {
  resolveAgentGCPolicy,
  resolveSidecarHeartbeat,
  resolveToolPackageCache,
  resolveWorkflowRunPackLimits,
} from "./config";

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
