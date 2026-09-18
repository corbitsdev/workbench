// Disposable HUB_DATA_DIR for tests that boot the hub or exercise
// seed/deploy git paths. Bun loads repo-root `.env`, so an unset test
// inherits `HUB_DATA_DIR=.data/hub` inside this work tree; the hub's
// git-on-disk init then walks up to the enclosing `.git` and a genesis
// commit can land on the working branch. This fixture mktemps outside
// any work tree, points HUB_DATA_DIR at it, and clears the local-dev
// opt-in so tests cannot inherit `HUB_ALLOW_GIT_INSIDE_WORK_TREE`.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createDisposableHubDataDir(): {
  hubDataDir: string;
  restore: () => void;
} {
  const previousDataDir = process.env["HUB_DATA_DIR"];
  const previousAllow = process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"];
  const hubDataDir = mkdtempSync(join(tmpdir(), "hub-data-"));
  process.env["HUB_DATA_DIR"] = hubDataDir;
  delete process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"];
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (previousDataDir === undefined) delete process.env["HUB_DATA_DIR"];
    else process.env["HUB_DATA_DIR"] = previousDataDir;
    if (previousAllow === undefined) {
      delete process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"];
    } else {
      process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"] = previousAllow;
    }
    rmSync(hubDataDir, { recursive: true, force: true });
  };
  return { hubDataDir, restore };
}

/** Installs a disposable HUB_DATA_DIR for the rest of this test file. */
export function installDisposableHubDataDir(): string {
  const { hubDataDir, restore } = createDisposableHubDataDir();
  afterAll(restore);
  return hubDataDir;
}
