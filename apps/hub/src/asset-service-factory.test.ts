import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBootAssetWiring } from "./asset-service-factory";
import { HubDataDirInsideGitWorkTreeError } from "./hub-data-dir-git-safety";

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function git(cwd: string, args: readonly string[]): void {
  const env = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  delete env["GIT_INDEX_FILE"];
  env["GIT_AUTHOR_NAME"] = "safety-test";
  env["GIT_AUTHOR_EMAIL"] = "safety@test";
  env["GIT_COMMITTER_NAME"] = "safety-test";
  env["GIT_COMMITTER_EMAIL"] = "safety@test";
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
}

test("createBootAssetWiring refuses a data dir inside an existing git work tree", async () => {
  const workTree = scratchDir("boot-asset-inside-");
  git(workTree, ["init", "-b", "main"]);
  const dataDir = path.join(workTree, ".data", "hub");
  mkdirSync(dataDir, { recursive: true });
  await expect(
    createBootAssetWiring({ db: {} as never, dataDir }),
  ).rejects.toBeInstanceOf(HubDataDirInsideGitWorkTreeError);
});

test("createBootAssetWiring opt-in skips the work-tree refusal", async () => {
  const workTree = scratchDir("boot-asset-opt-in-");
  git(workTree, ["init", "-b", "main"]);
  const dataDir = path.join(workTree, ".data", "hub");
  mkdirSync(dataDir, { recursive: true });
  try {
    await createBootAssetWiring({
      db: {} as never,
      dataDir,
      allowGitInsideWorkTree: true,
    });
  } catch (error) {
    expect(error).not.toBeInstanceOf(HubDataDirInsideGitWorkTreeError);
  }
});
