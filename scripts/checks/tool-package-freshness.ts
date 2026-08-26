// check:tool-package-freshness — a package whose `src/` changed must carry
// a version bump in the same change.
//
// Tool resolution keys on `name@version`. New source under an unchanged
// version never reaches a running or freshly-launched agent, and
// `publishCorbitsToolsRegistry` (`workbench setup`) rejects it at
// publish time — a publish/build failure, not a bench-create failure.
// Signup/`seedTenant` do not pack, so a dirty `src/` cannot abort
// minting a bench.
//
// `check:tool-package-pins` is the other half of this class: it compares a
// `{ name, version }` pin literal against that package's manifest. It passes
// when both sides agree at the same stale version — exactly the shape that
// keeps recurring (`@corbits/agent-directory-tools` in CL-6497,
// `@corbits/github-tools` at 0.0.5). Catching it needs the change's git
// history rather than a snapshot of the working tree, which is why it is a
// separate check.
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const PACKAGE_ROOT = "packages";

/**
 * The packages the hub publishes to its tool registry and that workflows
 * pin by `{ name, version }`. Sourced from `CORBITS_TOOL_PACKAGE_DIRS`
 * (`packages/tool-registry-publish/src/registry.ts`) — the same list the
 * publish step walks, so this check and the publisher agree on what a
 * "tool package" is. Every other workspace package is resolved by path,
 * not by version, and is deliberately out of scope.
 */
const TOOL_PACKAGE_REGISTRY = "packages/tool-registry-publish/src/registry.ts";

export function readToolPackageNames(source: string): string[] {
  const block = source.match(
    /CORBITS_TOOL_PACKAGE_DIRS[^=]*=\s*\[([\s\S]*?)\]/,
  );
  if (block === null) return [];
  return [...(block[1] ?? "").matchAll(/\.\.\/\.\.\/([a-z0-9-]+)/g)]
    .map((match) => match[1] ?? "")
    .filter((name) => name.length > 0)
    .sort();
}

export interface PackageChange {
  readonly name: string;
  readonly baseVersion: string | undefined;
  readonly headVersion: string | undefined;
}

function git(root: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * The commit this change branched from. CI supplies the base ref
 * explicitly; locally the merge base with `origin/main` answers the same
 * question a reviewer would ask.
 */
export function resolveBaseRef(
  root: string,
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return git(root, ["merge-base", "HEAD", "origin/main"]);
}

/**
 * The package names whose non-test `src/` files appear in a changed-file
 * list. Test files are excluded: they ship no source an agent resolves.
 */
export function packagesWithChangedSource(
  changedFiles: readonly string[],
  toolPackages: readonly string[],
): string[] {
  const isToolPackage = new Set(toolPackages);
  const touched = new Set<string>();
  for (const file of changedFiles) {
    const [root, name, dir] = file.split("/");
    if (root !== PACKAGE_ROOT || name === undefined || dir !== "src") continue;
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    if (!isToolPackage.has(name)) continue;
    touched.add(name);
  }
  return [...touched].sort();
}

/**
 * A package is fresh when its version moved with its source. A package
 * absent at the base ref is new, and its first version counts as a bump.
 */
export function auditFreshness(changes: readonly PackageChange[]): CheckReport {
  const report = emptyReport();
  for (const change of changes) {
    if (change.baseVersion === undefined) continue;
    if (change.headVersion !== change.baseVersion) continue;
    report.violations.push(
      `packages/${change.name}: src/ changed but package.json stayed at ` +
        `${change.baseVersion}. Tool resolution keys on name@version, so new ` +
        `source under an unchanged version never reaches a running or ` +
        `freshly launched agent and the hub rejects it at publish time. ` +
        `Bump the version, then update every { name, version } pin that ` +
        `references it.`,
    );
  }
  return report;
}

function versionAtRef(
  root: string,
  ref: string,
  name: string,
): string | undefined {
  const shown = git(root, [
    "show",
    `${ref}:${PACKAGE_ROOT}/${name}/package.json`,
  ]);
  if (shown === undefined) return undefined;
  return (JSON.parse(shown) as { version?: string }).version;
}

async function versionAtHead(
  root: string,
  name: string,
): Promise<string | undefined> {
  const manifest = Bun.file(
    path.join(root, PACKAGE_ROOT, name, "package.json"),
  );
  if (!(await manifest.exists())) return undefined;
  return ((await manifest.json()) as { version?: string }).version;
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  const baseRef = resolveBaseRef(root, process.env["CHECK_BASE_REF"]);
  if (baseRef === undefined) {
    const report = emptyReport();
    report.notes.push(
      "no base ref (no origin/main, no CHECK_BASE_REF); skipping — CI " +
        "supplies the base ref for the authoritative run",
    );
    reportAndExit("check:tool-package-freshness", report);
  }

  const registry = Bun.file(path.join(root, TOOL_PACKAGE_REGISTRY));
  const toolPackages = (await registry.exists())
    ? readToolPackageNames(await registry.text())
    : [];
  const diff = git(root, ["diff", "--name-only", `${baseRef}...HEAD`]);
  const names = packagesWithChangedSource(
    (diff ?? "").split("\n"),
    toolPackages,
  );
  const changes: PackageChange[] = [];
  for (const name of names) {
    changes.push({
      name,
      baseVersion: versionAtRef(root, baseRef, name),
      headVersion: await versionAtHead(root, name),
    });
  }

  const report = auditFreshness(changes);
  report.notes.push(
    `${names.length} package(s) with src/ changes since ${baseRef.slice(0, 8)}`,
  );
  reportAndExit("check:tool-package-freshness", report);
}

if (import.meta.main) await main();
