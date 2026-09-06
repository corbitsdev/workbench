// Fails loud when a `@corbits/*-tools` package's `src/` has moved on
// from the version already committed (the version seed will publish and
// that pins resolve as `name@version`). Publish skips an already-present
// filename and tar bytes are not deterministic, so a forgotten bump
// would otherwise ship nothing — running agents keep the old tools.
// Compared against git, not the live registry: the committed
// `package.json` version is the pin.

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import { CORBITS_TOOL_PACKAGE_DIRS } from "./registry";

const log = getLogger(["tool-registry-publish", "freshness-check"]);

const PackageManifest = type({
  name: "string",
  version: "string",
});

export type ToolPackageSnapshot = {
  name: string;
  dir: string;
  currentVersion: string;
  publishedVersion: string | undefined;
  srcChangedSincePublished: boolean;
};

export type StaleToolPackage = {
  name: string;
  dir: string;
  version: string;
};

export type CheckToolPackageFreshnessArgs = {
  packageDirs?: readonly string[];
};

/**
 * Packages whose `src/` differs from the tree at the last commit that
 * introduced `currentVersion`, while that version is still the one in
 * the working-tree manifest. A version bump (working tree or committed)
 * clears the finding — that is the only supported way to ship new
 * tool-package bytes.
 */
export function staleToolPackages(
  snapshots: readonly ToolPackageSnapshot[],
): StaleToolPackage[] {
  const stale: StaleToolPackage[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.publishedVersion === undefined) continue;
    if (snapshot.currentVersion !== snapshot.publishedVersion) continue;
    if (!snapshot.srcChangedSincePublished) continue;
    stale.push({
      name: snapshot.name,
      dir: snapshot.dir,
      version: snapshot.currentVersion,
    });
  }
  return stale;
}

export class StaleToolPackageError extends Error {
  readonly stale: readonly StaleToolPackage[];

  constructor(stale: readonly StaleToolPackage[]) {
    const names = stale.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ");
    super(
      `tool-package freshness: ${names} changed src/ without bumping version. ` +
        `Tool-package resolution keys on name@version, so shipping new source ` +
        `under an unchanged version never reaches a running or freshly-launched ` +
        `agent. Bump the package.json version before republishing.\n` +
        stale.map((pkg) => `  ${pkg.dir}`).join("\n"),
    );
    this.name = "StaleToolPackageError";
    this.stale = stale;
  }
}

export function assertToolPackagesFresh(
  snapshots: readonly ToolPackageSnapshot[],
): void {
  const stale = staleToolPackages(snapshots);
  if (stale.length > 0) throw new StaleToolPackageError(stale);
}

export async function snapshotToolPackages(
  packageDirs: readonly string[] = CORBITS_TOOL_PACKAGE_DIRS,
): Promise<ToolPackageSnapshot[]> {
  return Promise.all(packageDirs.map(snapshotOnePackage));
}

/**
 * Snapshot every registered tool package and throw
 * `StaleToolPackageError` if any `src/` moved without a version bump.
 * `packageDirs` defaults to `CORBITS_TOOL_PACKAGE_DIRS` — the same
 * publish map `publishCorbitsToolsRegistry` walks.
 */
export async function checkToolPackageFreshness(
  args: CheckToolPackageFreshnessArgs = {},
): Promise<void> {
  const snapshots = await snapshotToolPackages(
    args.packageDirs ?? CORBITS_TOOL_PACKAGE_DIRS,
  );
  assertToolPackagesFresh(snapshots);
}

async function snapshotOnePackage(dir: string): Promise<ToolPackageSnapshot> {
  const resolvedDir = await realpath(dir);
  const manifest = await readManifest(path.join(resolvedDir, "package.json"));
  const root = await repoRootFor(resolvedDir);
  if (root === undefined) {
    throw new Error(
      `tool-package freshness: ${dir} is not inside a git work tree; ` +
        `src/ cannot be compared to the published version`,
    );
  }

  const resolvedRoot = await realpath(root);
  const relManifest = gitPath(
    resolvedRoot,
    path.join(resolvedDir, "package.json"),
  );
  const relSrc = gitPath(resolvedRoot, path.join(resolvedDir, "src"));
  const publishedVersion = await committedVersion(root, relManifest);
  const srcChangedSincePublished =
    publishedVersion !== undefined &&
    publishedVersion === manifest.version &&
    (await srcChangedSinceVersion(root, relManifest, relSrc, manifest.version));

  return {
    name: manifest.name,
    dir,
    currentVersion: manifest.version,
    publishedVersion,
    srcChangedSincePublished,
  };
}

async function readManifest(
  manifestPath: string,
): Promise<{ name: string; version: string }> {
  return parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
}

function parseManifest(
  jsonText: string,
  label: string,
): { name: string; version: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `tool-package freshness: ${label} is not valid JSON: ${String(err)}`,
      { cause: err },
    );
  }
  const parsed = PackageManifest(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `tool-package freshness: ${label} failed validation: ${parsed.summary}`,
    );
  }
  return parsed;
}

async function committedVersion(
  root: string,
  relManifest: string,
): Promise<string | undefined> {
  const shown = await git(root, ["show", `HEAD:${relManifest}`]);
  if (shown.code !== 0) return undefined;
  return parseManifest(shown.stdout, `HEAD:${relManifest}`).version;
}

/**
 * True when `relSrc` differs from the oldest commit that still carries
 * `version` in `relManifest` (the bump that introduced it), including
 * uncommitted and untracked files. Walking `git log` of the manifest
 * rather than pickaxe-searching the version string so a reformatted
 * `package.json` cannot hide a forgotten bump.
 */
async function srcChangedSinceVersion(
  root: string,
  relManifest: string,
  relSrc: string,
  version: string,
): Promise<boolean> {
  const since = await lastCommitIntroducingVersion(root, relManifest, version);
  if (since === undefined) return false;
  const diff = await git(root, ["diff", "--name-only", since, "--", relSrc]);
  if (diff.stdout.trim() !== "") return true;
  const untracked = await git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    relSrc,
  ]);
  return untracked.stdout.trim() !== "";
}

async function lastCommitIntroducingVersion(
  root: string,
  relManifest: string,
  version: string,
): Promise<string | undefined> {
  const log = await git(root, ["log", "--format=%H", "--", relManifest]);
  if (log.code !== 0 || log.stdout.trim() === "") return undefined;
  let oldestWithVersion: string | undefined;
  for (const commit of log.stdout.split("\n").filter(Boolean)) {
    const shown = await git(root, ["show", `${commit}:${relManifest}`]);
    if (shown.code !== 0) continue;
    const parsed = parseManifest(shown.stdout, `${commit}:${relManifest}`);
    if (parsed.version !== version) break;
    oldestWithVersion = commit;
  }
  return oldestWithVersion;
}

async function repoRootFor(dir: string): Promise<string | undefined> {
  const result = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return undefined;
  return result.stdout.trim();
}

function gitPath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (Bun.which("git") === null) {
    throw new Error(
      "tool-package freshness: git is not installed or not on PATH; " +
        "src/ cannot be compared to the published version",
    );
  }
  // Hooks export repository selectors; cwd must select the package's repo,
  // not the index or object database of the repository running the hook.
  const repositoryEnvKeys = new Set([
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !repositoryEnvKeys.has(key)),
  );
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

if (import.meta.main) {
  try {
    await checkToolPackageFreshness();
  } catch (err) {
    log.error`${err instanceof Error ? err.message : String(err)}`;
    process.exit(1);
  }
}
