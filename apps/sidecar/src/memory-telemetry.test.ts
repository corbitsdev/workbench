import { describe, expect, test } from "bun:test";
import {
  resolveGcIntervalMs,
  resolveMemoryLogIntervalMs,
  toMemoryMb,
} from "./memory-telemetry";

describe("resolveMemoryLogIntervalMs", () => {
  test("defaults to 60s when unset", () => {
    expect(resolveMemoryLogIntervalMs(undefined)).toBe(60_000);
  });

  test("honors a positive override", () => {
    expect(resolveMemoryLogIntervalMs("5000")).toBe(5000);
  });

  test("falls back to default for invalid or non-positive values", () => {
    expect(resolveMemoryLogIntervalMs("0")).toBe(60_000);
    expect(resolveMemoryLogIntervalMs("-1")).toBe(60_000);
    expect(resolveMemoryLogIntervalMs("nonsense")).toBe(60_000);
  });
});

describe("resolveGcIntervalMs", () => {
  test("defaults to 5min when unset", () => {
    expect(resolveGcIntervalMs(undefined)).toBe(300_000);
  });

  test("honors a positive override", () => {
    expect(resolveGcIntervalMs("120000")).toBe(120_000);
  });

  test("0 disables (passes through)", () => {
    expect(resolveGcIntervalMs("0")).toBe(0);
  });

  test("falls back to default for invalid or negative values", () => {
    expect(resolveGcIntervalMs("-5")).toBe(300_000);
    expect(resolveGcIntervalMs("nonsense")).toBe(300_000);
  });
});

describe("toMemoryMb", () => {
  test("converts bytes to rounded MB per field", () => {
    const usage = {
      rss: 6_547_540 * 1024, // ~6394 MB
      heapUsed: 500 * 1024 * 1024,
      heapTotal: 700 * 1024 * 1024,
      external: 44 * 1024 * 1024,
      arrayBuffers: 12 * 1024 * 1024,
    } as NodeJS.MemoryUsage;
    expect(toMemoryMb(usage)).toEqual({
      rss: 6394,
      heapUsed: 500,
      heapTotal: 700,
      external: 44,
      arrayBuffers: 12,
    });
  });

  test("surfaces the rss-vs-heapUsed gap (allocator-retained memory)", () => {
    // A large rss with a small heapUsed is the sticky/fragmented signature we
    // are instrumenting for — the conversion must preserve both independently.
    const mb = toMemoryMb({
      rss: 6000 * 1024 * 1024,
      heapUsed: 300 * 1024 * 1024,
      heapTotal: 400 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    } as NodeJS.MemoryUsage);
    expect(mb.rss - mb.heapUsed).toBe(5700);
  });
});
