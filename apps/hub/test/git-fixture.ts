// Shared git-fixture helper for apps/hub's own tests (CL-7372):
// `asset-service-factory.test.ts` and `hub-data-dir-git-safety.test.ts`
// each duplicated an mkdtemp-scratch-dir-plus-`git()` helper before this —
// this is the one shared copy. Every fixture repo lives in its own
// mkdtemp scratch directory outside this repository's own work tree, and
// every git invocation runs with GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
// unset so it can never pick up an inherited pointer at real history.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scratch: string[] = [];
let repositoryRoot: string | undefined;

function findRepositoryRoot(): string {
  if (repositoryRoot === undefined) {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git rev-parse --show-toplevel failed: ${result.stderr.toString()}`,
      );
    }
    repositoryRoot = realpathSync(result.stdout.toString().trim());
  }
  return repositoryRoot;
}

/** Throws if `dir` sits inside this repository's own work tree — a git
 * fixture must live in an mkdtemp scratch dir outside any real work tree,
 * never inside the checkout a stray commit could actually corrupt. */
function assertOutsideRepository(dir: string): void {
  const resolved = realpathSync(dir);
  const root = findRepositoryRoot();
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `git fixture directory ${resolved} is inside the repository root ` +
        `${root} — fixtures must live in an mkdtemp scratch dir outside ` +
        `any work tree.`,
    );
  }
}

/** Creates a fresh mkdtemp scratch directory for a git fixture and tracks
 * it for `cleanupGitFixtures`. */
export function scratchGitFixtureDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** Runs `git` synchronously against `cwd`, guarded against ever touching
 * this repository's own history: GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE are
 * stripped from the child's env, and `cwd` is asserted outside the
 * repository root before the process ever spawns. */
export function gitFixture(cwd: string, args: readonly string[]): void {
  mkdirSync(cwd, { recursive: true });
  assertOutsideRepository(cwd);
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

/** Removes every scratch directory this module created. Call from the
 * test file's own `afterAll`. */
export function cleanupGitFixtures(): void {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
