import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertHubDataDirGitSafety,
  enclosingGitWorkTree,
  HubDataDirInsideGitWorkTreeError,
} from "./hub-data-dir-git-safety";

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

test("a directory with no enclosing git work tree is allowed", () => {
  const dir = scratchDir("hub-data-outside-");
  expect(enclosingGitWorkTree(dir)).toBeNull();
  expect(() => assertHubDataDirGitSafety(dir)).not.toThrow();
});

test("a directory inside an existing git work tree fails loud", () => {
  const workTree = scratchDir("hub-data-inside-wt-");
  git(workTree, ["init", "-b", "main"]);
  writeFileSync(path.join(workTree, "keep.txt"), "keep\n");
  git(workTree, ["add", "keep.txt"]);
  git(workTree, ["commit", "-m", "keep"]);
  const dataDir = path.join(workTree, ".data", "hub");
  mkdirSync(dataDir, { recursive: true });

  expect(enclosingGitWorkTree(dataDir)).toBe(realpathSync(workTree));
  expect(() => assertHubDataDirGitSafety(dataDir)).toThrow(
    HubDataDirInsideGitWorkTreeError,
  );
  try {
    assertHubDataDirGitSafety(dataDir);
    throw new Error("expected assertHubDataDirGitSafety to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(HubDataDirInsideGitWorkTreeError);
    const message = (error as Error).message;
    expect(message).toContain(realpathSync(dataDir));
    expect(message).toContain(realpathSync(workTree));
    expect(message).toContain("HUB_ALLOW_GIT_INSIDE_WORK_TREE=1");
    expect(message).toContain("refuses");
  }
});

test("opt-in allows initializing inside an existing git work tree", () => {
  const workTree = scratchDir("hub-data-opt-in-");
  git(workTree, ["init", "-b", "main"]);
  const dataDir = path.join(workTree, ".data", "hub");
  expect(() =>
    assertHubDataDirGitSafety(dataDir, { allowInsideWorkTree: true }),
  ).not.toThrow();
});
