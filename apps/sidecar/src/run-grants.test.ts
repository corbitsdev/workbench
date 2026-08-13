import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { RepoStore } from "@intx/hub-sessions";

import { readRunGrants, runGrantsPath } from "./run-grants";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeRepoStore(): Promise<{ store: RepoStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "run-grants-"));
  tempDirs.push(dir);
  const store = {
    getRepoDir: () => dir,
  } as unknown as RepoStore;
  return { store, dir };
}

test("runGrantsPath keys the file under the run's own subtree", () => {
  expect(runGrantsPath("run-1")).toBe("runs/run-1/grants.json");
});

test("readRunGrants returns undefined when the grants file is absent", async () => {
  const { store } = await makeRepoStore();
  const grants = await readRunGrants({
    repoStore: store,
    deploymentId: "dep-1",
    runId: "run-1",
  });
  expect(grants).toBeUndefined();
});

test("readRunGrants returns the grants array from a valid file", async () => {
  const { store, dir } = await makeRepoStore();
  const filePath = path.join(dir, runGrantsPath("run-1"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({ grants: [{ resource: "tool:echo", action: "invoke" }] }),
  );
  const grants = await readRunGrants({
    repoStore: store,
    deploymentId: "dep-1",
    runId: "run-1",
  });
  expect(grants).toEqual([{ resource: "tool:echo", action: "invoke" }]);
});

test("readRunGrants throws on a file that is not valid JSON", async () => {
  const { store, dir } = await makeRepoStore();
  const filePath = path.join(dir, runGrantsPath("run-1"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "not json");
  await expect(
    readRunGrants({ repoStore: store, deploymentId: "dep-1", runId: "run-1" }),
  ).rejects.toThrow(/not valid JSON/);
});

test("readRunGrants throws on a file missing the grants envelope", async () => {
  const { store, dir } = await makeRepoStore();
  const filePath = path.join(dir, runGrantsPath("run-1"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ notGrants: [] }));
  await expect(
    readRunGrants({ repoStore: store, deploymentId: "dep-1", runId: "run-1" }),
  ).rejects.toThrow(/failed validation/);
});
