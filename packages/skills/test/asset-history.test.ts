// Consumer history must hide the hub's genesis commit — a person who just
// created a skill should see their "Create …" version, never the substrate's
// "Initialize repository" scaffolding authored as interchange-hub.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import git from "isomorphic-git";

import { readAssetCommitHistory } from "../src/asset-history";
import type { RepoId, RepoStore } from "@intx/hub-sessions";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-history-"));
  dirs.push(dir);
  return dir;
}

function repoStoreFor(dir: string): RepoStore {
  return {
    getRepoDir: async (_id: RepoId) => dir,
  } as unknown as RepoStore;
}

describe("readAssetCommitHistory", () => {
  test("hides the Initialize repository genesis from consumer history", async () => {
    const dir = tempDir();
    await git.init({ fs, dir, defaultBranch: "main" });
    await fs.promises.writeFile(path.join(dir, ".gitignore"), "keys/\n");
    await git.add({ fs, dir, filepath: ".gitignore" });
    await git.commit({
      fs,
      dir,
      message: "Initialize repository",
      author: {
        name: "interchange-hub",
        email: "hub@interchange.local",
      },
    });
    await fs.promises.mkdir(path.join(dir, "triage"), { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Sort issues.\n---\n\nBody.\n",
    );
    await git.add({ fs, dir, filepath: "triage/SKILL.md" });
    await git.commit({
      fs,
      dir,
      message: "Create triage",
      author: {
        name: "interchange-hub",
        email: "hub@interchange.local",
      },
    });

    const history = await readAssetCommitHistory({
      repoStore: repoStoreFor(dir),
      kind: "skill",
      assetId: "asset_1",
      ref: "main",
    });

    expect(history.map((entry) => entry.message)).toEqual(["Create triage"]);
    expect(
      history.some((entry) => entry.message === "Initialize repository"),
    ).toBe(false);
  });
});
