// Freshness gate for the apps/web production bundle the browser suites
// serve: files in one `bun test e2e` process run serially, so the first
// browser suite builds and the rest reuse its dist when the tree hasn't
// changed since. The fingerprint is HEAD plus the full worktree status, so
// any tracked change, new file, or new commit rebuilds; ignored paths
// (node_modules, .worktrees) never participate. Without git there is no
// fingerprint, and the caller always rebuilds — the old behavior.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const WEB_BUILD_MARKER = ".e2e-build-fingerprint";

function gitOutput(repoRoot: string, args: readonly string[]): string | null {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString();
}

export function webBuildFingerprint(
  repoRoot: string,
  excludeStatusPaths: readonly string[] = [],
): string | null {
  const head = gitOutput(repoRoot, ["rev-parse", "HEAD"]);
  const status = gitOutput(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (head === null || status === null) return null;
  const excluded = new Set(excludeStatusPaths);
  const lines = status.split("\n").filter((line) => {
    if (line === "") return false;
    // Porcelain v1: `XY PATH`; quote-wrapped when the path needs it.
    const quoted = line.slice(3);
    const unquoted =
      quoted.length >= 2 && quoted.startsWith('"') && quoted.endsWith('"')
        ? quoted.slice(1, -1)
        : quoted;
    return !excluded.has(unquoted);
  });
  return `${head.trim()}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

function markerPath(webDir: string): string {
  return path.join(webDir, "dist", WEB_BUILD_MARKER);
}

// The marker is itself an untracked file, so it must not participate in the
// fingerprint it records — otherwise writing it would invalidate it.
function markerStatusPath(webDir: string, repoRoot: string): string {
  return path.relative(repoRoot, markerPath(webDir));
}

export function isWebBuildFresh(
  webDir: string,
  repoRoot: string,
  // Repo-root-relative build artifacts the web build produces alongside
  // dist (today the worker bundle): the marker matches the tree, but a
  // deleted artifact still means rebuild.
  requiredArtifacts: readonly string[] = [],
): boolean {
  const fingerprint = webBuildFingerprint(repoRoot, [markerStatusPath(webDir, repoRoot)]);
  if (fingerprint === null) return false;
  let marker: string;
  try {
    marker = readFileSync(markerPath(webDir), "utf8");
  } catch {
    return false;
  }
  if (marker !== fingerprint) return false;
  return requiredArtifacts.every((artifact) => existsSync(path.join(repoRoot, artifact)));
}

export function writeWebBuildMarker(webDir: string, repoRoot: string): void {
  const fingerprint = webBuildFingerprint(repoRoot, [markerStatusPath(webDir, repoRoot)]);
  if (fingerprint === null) return;
  writeFileSync(markerPath(webDir), fingerprint);
}
