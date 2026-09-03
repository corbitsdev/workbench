import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  cleanupGitFixtures,
  gitFixture,
  scratchGitFixtureDir,
} from "../test/git-fixture";
import { createBootAssetWiring } from "./asset-service-factory";
import { HubDataDirInsideGitWorkTreeError } from "./hub-data-dir-git-safety";

afterAll(cleanupGitFixtures);

test("createBootAssetWiring refuses a data dir inside an existing git work tree", async () => {
  const workTree = scratchGitFixtureDir("boot-asset-inside-");
  gitFixture(workTree, ["init", "-b", "main"]);
  const dataDir = path.join(workTree, ".data", "hub");
  mkdirSync(dataDir, { recursive: true });
  await expect(
    createBootAssetWiring({ db: {} as never, dataDir }),
  ).rejects.toBeInstanceOf(HubDataDirInsideGitWorkTreeError);
});

test("createBootAssetWiring opt-in skips the work-tree refusal", async () => {
  const workTree = scratchGitFixtureDir("boot-asset-opt-in-");
  gitFixture(workTree, ["init", "-b", "main"]);
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
