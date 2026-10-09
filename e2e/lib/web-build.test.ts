// Freshness gate for the apps/web production bundle the browser suites
// serve: a dist marker matching the working-tree fingerprint means the
// current tree already built it, so bootBrowserApp can skip its rebuild.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isWebBuildFresh, webBuildFingerprint, writeWebBuildMarker } from "./web-build";

function git(dir: string, args: readonly string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}`);
}

function initRepo(): { repo: string; web: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "web-build-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  // The developer's global git config may sign commits or install hooks;
  // neither exists usefully inside a throwaway repo.
  const hooks = path.join(repo, "no-hooks");
  mkdirSync(hooks, { recursive: true });
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.hooksPath", hooks]);
  writeFileSync(path.join(repo, "src.txt"), "v1");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  const web = path.join(repo, "web");
  mkdirSync(path.join(web, "dist"), { recursive: true });
  return { repo, web };
}

test("a matching marker means fresh; any tree change means rebuild", () => {
  const { repo, web } = initRepo();
  expect(webBuildFingerprint(repo)).not.toBeNull();
  // No marker yet: build.
  expect(isWebBuildFresh(web, repo)).toBe(false);
  writeWebBuildMarker(web, repo);
  expect(isWebBuildFresh(web, repo)).toBe(true);
  // A tracked modification invalidates the marker.
  writeFileSync(path.join(repo, "src.txt"), "v2");
  expect(isWebBuildFresh(web, repo)).toBe(false);
  writeWebBuildMarker(web, repo);
  expect(isWebBuildFresh(web, repo)).toBe(true);
  // So does an untracked file: it may be a new build input.
  writeFileSync(path.join(repo, "new-input.txt"), "untracked");
  expect(isWebBuildFresh(web, repo)).toBe(false);
});

test("a new commit invalidates the marker", () => {
  const { repo, web } = initRepo();
  writeWebBuildMarker(web, repo);
  expect(isWebBuildFresh(web, repo)).toBe(true);
  writeFileSync(path.join(repo, "src.txt"), "v2");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "change"]);
  expect(isWebBuildFresh(web, repo)).toBe(false);
});

test("an env flip invalidates the marker under an unchanged tree", () => {
  const { repo, web } = initRepo();
  const config = { baseUrl: "http://localhost:3000" };
  writeWebBuildMarker(web, repo, config);
  expect(isWebBuildFresh(web, repo, [], config)).toBe(true);
  // Same tree, different effective build config (e.g. BASE_URL the vite
  // build reads): the dist would differ, so it must read as stale even
  // though HEAD and status are identical.
  const flipped = { baseUrl: "http://localhost:4000" };
  expect(isWebBuildFresh(web, repo, [], flipped)).toBe(false);
  writeWebBuildMarker(web, repo, flipped);
  expect(isWebBuildFresh(web, repo, [], flipped)).toBe(true);
  // Back to the original config: stale again, not mistaken for fresh.
  expect(isWebBuildFresh(web, repo, [], config)).toBe(false);
});

test("a non-serializable build config is rejected loudly", () => {
  const { repo } = initRepo();
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  expect(() => webBuildFingerprint(repo, [], circular)).toThrow(/JSON-serializable/);
});

test("a missing build artifact means rebuild even with a matching marker", () => {
  const { repo, web } = initRepo();
  mkdirSync(path.join(repo, "pkg"), { recursive: true });
  writeFileSync(path.join(repo, "pkg", "out.js"), "built");
  writeWebBuildMarker(web, repo);
  expect(isWebBuildFresh(web, repo, ["pkg/out.js"])).toBe(true);
  // Deleting the artifact (and re-marking, so status matches again) must
  // still read stale: only the existence check can catch this.
  rmSync(path.join(repo, "pkg", "out.js"));
  writeWebBuildMarker(web, repo);
  expect(isWebBuildFresh(web, repo, ["pkg/out.js"])).toBe(false);
  expect(isWebBuildFresh(web, repo)).toBe(true);
});

test("without git the build is never fresh", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "web-build-nogit-"));
  const web = path.join(dir, "web");
  mkdirSync(path.join(web, "dist"), { recursive: true });
  expect(webBuildFingerprint(dir)).toBeNull();
  expect(isWebBuildFresh(web, dir)).toBe(false);
  writeWebBuildMarker(web, dir);
  expect(isWebBuildFresh(web, dir)).toBe(false);
});
