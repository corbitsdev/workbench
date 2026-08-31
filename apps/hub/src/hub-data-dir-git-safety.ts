// Refuse to initialize hub git-on-disk state inside an existing git work
// tree. isomorphic-git walks up from `dataDir` looking for `.git`; when
// HUB_DATA_DIR lives inside this repo (the `.env` default `.data/hub`),
// a missed nested init authors a genesis commit onto the working branch
// and a checkout of that tree can delete the checkout.
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

const GIT_DIR_VARS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]);

export function envWithoutGitDir(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (GIT_DIR_VARS.has(key)) continue;
    next[key] = value;
  }
  return next;
}

export function enclosingGitWorkTree(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const absolute = path.resolve(dir);
  mkdirSync(absolute, { recursive: true });
  const canonical = realpathSync(absolute);
  const result = spawnSync(
    "git",
    ["-c", "safe.directory=*", "-C", canonical, "rev-parse", "--show-toplevel"],
    { encoding: "utf8", env: envWithoutGitDir(env) },
  );
  if (result.status !== 0) return null;
  const toplevel = result.stdout.trim();
  return toplevel === "" ? null : realpathSync(toplevel);
}

export class HubDataDirInsideGitWorkTreeError extends Error {
  readonly hubDataDir: string;
  readonly enclosingWorkTree: string;

  constructor(hubDataDir: string, enclosingWorkTree: string) {
    super(
      [
        `HUB_DATA_DIR (${hubDataDir}) is inside the git work tree at ${enclosingWorkTree}.`,
        "The hub refuses to initialize git-on-disk state there: a nested",
        "init that misses its own .git walks up and commits onto the working",
        "branch, which can delete the checkout.",
        "Point HUB_DATA_DIR at a directory outside any git work tree, or set",
        "HUB_ALLOW_GIT_INSIDE_WORK_TREE=1 to opt in.",
      ].join(" "),
    );
    this.name = "HubDataDirInsideGitWorkTreeError";
    this.hubDataDir = hubDataDir;
    this.enclosingWorkTree = enclosingWorkTree;
  }
}

export function assertHubDataDirGitSafety(
  dir: string,
  opts?: {
    allowInsideWorkTree?: boolean;
    env?: NodeJS.ProcessEnv;
  },
): void {
  if (opts?.allowInsideWorkTree === true) return;
  const enclosing = enclosingGitWorkTree(dir, opts?.env ?? process.env);
  if (enclosing === null) return;
  throw new HubDataDirInsideGitWorkTreeError(
    realpathSync(path.resolve(dir)),
    enclosing,
  );
}
