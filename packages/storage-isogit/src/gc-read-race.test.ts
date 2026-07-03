import { describe, test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAgentRepo } from "./init";
import { IsogitStore } from "./store";
import type { GCPolicy } from "./gc";

// WORKBENCH-LOCAL (CL-2663) — regression guard for the read-vs-GC race.
// Store reads (readAt/log walk git objects) are NOT serialized under the
// repo-dir lock, while the write path's maybeGCUnderLock republishes a
// consolidated pack and deletes the superseded ones. Before the CL-2663
// lock-serialized reads in store.ts (log/readAt/readManifestHistory under
// withRepoDirLock), GC removing a pack between iso-git's pack enumeration
// and its pack read made the read fail on a still-reachable object —
// InternalError "Could not read packfile ..." plus bare TypeErrors from
// torn .idx loads (readAt degraded to [] via readBlobAtCommit's null path;
// log threw). Reproduced 5/5 before the fix, usually within a few
// iterations; a narrow pack-miss retry was insufficient (the TypeError
// shapes are unmatchable). This test drives the same interleaving and
// asserts zero read failures. See docs/VENDORED.md (storage-isogit entry).

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const d = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "isogit-gc-read-race-"),
  );
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((d) => fs.promises.rm(d, { recursive: true, force: true })),
  );
});

const AGGRESSIVE_GC: GCPolicy = {
  packThreshold: 1,
  looseThreshold: 1,
  warnBytes: 1024 * 1024 * 1024,
  retention: "keep-history",
};

describe("read vs write-path GC interleaving", () => {
  test("lock-free reads survive concurrent pack republish/removal", async () => {
    const dir = await tempDir();
    await initAgentRepo(dir);
    const store = new IsogitStore(dir, undefined, AGGRESSIVE_GC);

    // Seed a commit whose objects every subsequent GC must keep reachable
    // (keep-history) — the reader targets it while packs churn underneath.
    await store.writeTurns([
      { role: "user", content: [{ type: "text", text: "seed" }], timestamp: 1 },
    ]);
    const seed = await store.commit({ message: "seed" });

    const iterations = 40;
    let stopped = false;

    async function writer(): Promise<void> {
      for (let i = 0; i < iterations; i += 1) {
        await store.writeBlob(
          `call-${String(i)}`,
          new TextEncoder().encode(`payload ${String(i)}`),
          "text/plain",
        );
        // looseThreshold 1 → this commit's write path runs a full reclaim
        // (new consolidated pack published, prior packs deleted).
        await store.commit({ message: `churn ${String(i)}` });
      }
      stopped = true;
    }

    async function reader(): Promise<number> {
      let reads = 0;
      while (!stopped) {
        // Both walk git objects (commit → tree → blob) without the repo
        // lock. Zero failures allowed: readAt must always see the seed turn
        // (a pack-miss would degrade it to []) and log must never throw.
        const turns = await store.readAt(seed.hash);
        expect(turns.length).toBe(1);
        const log = await store.log(5);
        expect(log.length).toBeGreaterThan(0);
        reads += 1;
      }
      return reads;
    }

    const [, reads] = await Promise.all([writer(), reader()]);
    // The guard is only meaningful if reads actually overlapped the churn.
    expect(reads).toBeGreaterThan(10);
  }, 15_000);
});
