import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@intx/log";

const log = getLogger(["sidecar", "memory"]);

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Resolve the memory-usage log interval from `SIDECAR_MEMORY_LOG_INTERVAL_MS`.
 * Falls back to 60s for a missing/invalid/non-positive value.
 */
export function resolveMemoryLogIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

export interface MemoryMb {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

/**
 * Convert a `process.memoryUsage()` snapshot (bytes) to whole MB. The
 * `rss`-minus-`heapUsed` gap measures allocator-retained/fragmented memory that
 * a GC would not return; `external`/`arrayBuffers` isolate off-heap Buffers
 * (e.g. inlined attachment blobs) from the JS object heap.
 */
export function toMemoryMb(usage: NodeJS.MemoryUsage): MemoryMb {
  const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);
  return {
    rss: mb(usage.rss),
    heapUsed: mb(usage.heapUsed),
    heapTotal: mb(usage.heapTotal),
    external: mb(usage.external),
    arrayBuffers: mb(usage.arrayBuffers),
  };
}

export function logMemoryUsage(): void {
  log.info(
    "memory usage rss={rss}MB heapUsed={heapUsed}MB heapTotal={heapTotal}MB external={external}MB arrayBuffers={arrayBuffers}MB",
    { ...toMemoryMb(process.memoryUsage()) },
  );
}

async function writeHeapSnapshot(dataDir: string): Promise<void> {
  try {
    const path = join(dataDir, `heap-${Date.now()}.heapsnapshot`);
    // "v8" format loads directly in Chrome DevTools' Memory tab.
    const snapshot = Bun.generateHeapSnapshot("v8");
    await writeFile(
      path,
      typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot),
    );
    log.info("wrote heap snapshot to {path}", { path });
  } catch (err) {
    log.error("heap snapshot failed: {msg}", {
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start periodic memory-usage logging and register a `SIGUSR2` handler that
 * dumps a Chrome-DevTools-loadable heap snapshot to `dataDir` on demand
 * (`kill -SIGUSR2 <pid>`). Returns a stop function. Always-on, cheap
 * observability so the sidecar's resident-heap composition is measurable in
 * production without a redeploy.
 */
export function startMemoryTelemetry(dataDir: string): () => void {
  const intervalMs = resolveMemoryLogIntervalMs(
    process.env["SIDECAR_MEMORY_LOG_INTERVAL_MS"],
  );
  logMemoryUsage();
  const timer = setInterval(logMemoryUsage, intervalMs);
  timer.unref?.();

  const onSignal = (): void => {
    void writeHeapSnapshot(dataDir);
  };
  process.on("SIGUSR2", onSignal);

  return () => {
    clearInterval(timer);
    process.off("SIGUSR2", onSignal);
  };
}
