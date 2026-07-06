import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@intx/log";

const log = getLogger(["sidecar", "memory"]);

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_GC_INTERVAL_MS = 300_000;

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
  // No `.unref()`: an unref'd interval does not set the event-loop poll
  // timeout, so on a quiet sidecar (little WS traffic) the loop blocks on I/O
  // and the timer never fires. The sidecar is a long-running daemon, so a
  // ref'd timer is correct.
  const timer = setInterval(logMemoryUsage, intervalMs);

  const onSignal = (): void => {
    void writeHeapSnapshot(dataDir);
  };
  process.on("SIGUSR2", onSignal);

  return () => {
    clearInterval(timer);
    process.off("SIGUSR2", onSignal);
  };
}

/**
 * Resolve the forced-GC interval from `SIDECAR_FORCE_GC_INTERVAL_MS`. `0`
 * disables. Falls back to 5min for a missing/invalid/negative value.
 */
export function resolveGcIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_GC_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GC_INTERVAL_MS;
  return n;
}

/**
 * Force a synchronous GC and log rss/heapUsed before and after. Bun (mimalloc)
 * does not return freed heap to the OS on its own, so a slept agent's turn
 * memory becomes GC-eligible but RSS stays at the high-water-mark until a GC is
 * forced. This both RECLAIMS that memory and instruments whether the drop is
 * real (sticky heap → rss falls) or the references are still held (real leak →
 * rss flat, heapUsed flat).
 */
export function runForcedGc(): void {
  const before = toMemoryMb(process.memoryUsage());
  Bun.gc(true);
  const after = toMemoryMb(process.memoryUsage());
  log.info(
    "forced gc rssBefore={rssBefore}MB rssAfter={rssAfter}MB rssReclaimed={rssReclaimed}MB heapUsedBefore={heapUsedBefore}MB heapUsedAfter={heapUsedAfter}MB",
    {
      rssBefore: before.rss,
      rssAfter: after.rss,
      rssReclaimed: before.rss - after.rss,
      heapUsedBefore: before.heapUsed,
      heapUsedAfter: after.heapUsed,
    },
  );
}

/**
 * Start a periodic forced GC so the sidecar returns freed heap to the OS
 * instead of climbing monotonically to its peak concurrent load. Returns a stop
 * function; a `0` interval disables it (returns a no-op).
 */
export function startPeriodicGc(): () => void {
  const intervalMs = resolveGcIntervalMs(
    process.env["SIDECAR_FORCE_GC_INTERVAL_MS"],
  );
  if (intervalMs === 0) return () => {};
  const timer = setInterval(runForcedGc, intervalMs);
  return () => clearInterval(timer);
}
