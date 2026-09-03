import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  cleanupGitFixtures,
  gitFixture,
  scratchGitFixtureDir,
} from "../test/git-fixture";
import {
  assertHubDataDirGitSafety,
  enclosingGitWorkTree,
  HubDataDirInsideGitWorkTreeError,
} from "./hub-data-dir-git-safety";

afterAll(cleanupGitFixtures);

test("a directory with no enclosing git work tree is allowed", () => {
  const dir = scratchGitFixtureDir("hub-data-outside-");
  expect(enclosingGitWorkTree(dir)).toBeNull();
  expect(() => assertHubDataDirGitSafety(dir)).not.toThrow();
});

test("a directory inside an existing git work tree fails loud", () => {
  const workTree = scratchGitFixtureDir("hub-data-inside-wt-");
  gitFixture(workTree, ["init", "-b", "main"]);
  writeFileSync(path.join(workTree, "keep.txt"), "keep\n");
  gitFixture(workTree, ["add", "keep.txt"]);
  gitFixture(workTree, ["commit", "-m", "keep"]);
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
  const workTree = scratchGitFixtureDir("hub-data-opt-in-");
  gitFixture(workTree, ["init", "-b", "main"]);
  const dataDir = path.join(workTree, ".data", "hub");
  expect(() =>
    assertHubDataDirGitSafety(dataDir, { allowInsideWorkTree: true }),
  ).not.toThrow();
});
