// check:packages — package hygiene.
//
// Every workspace package must build, pass its tests run from its own
// directory, and — when it declares an exports field — survive
// consumption from outside the workspace: the packed artifact (bun pm
// pack) must contain every file its exports promise, and its entry
// must import by package name from a staging directory where only its
// declared dependencies are present. "Works in the repo" has to mean
// "works when published".
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Glob } from "bun";
import { collectExportTargets, declaredDependencyNames } from "./lib/exports";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

/** The tarball filename `bun pm pack` produces for a package. */
export function tarballNameFor(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  exports?: unknown;
  dependencies?: Record<string, string>;
}

interface WorkspacePackage {
  /** Directory relative to the root, e.g. packages/module. */
  dir: string;
  packageJson: PackageJson;
}

async function listWorkspacePackages(
  root: string,
): Promise<WorkspacePackage[]> {
  const glob = new Glob("{apps,packages,tools,workflows}/*/package.json");
  const packages: WorkspacePackage[] = [];
  for await (const manifestPath of glob.scan(root)) {
    packages.push({
      dir: path.dirname(manifestPath),
      packageJson: (await Bun.file(
        path.join(root, manifestPath),
      ).json()) as PackageJson,
    });
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

function run(
  command: readonly string[],
  cwd: string,
): { ok: boolean; output: string } {
  const result = Bun.spawnSync([...command], { cwd, stderr: "pipe" });
  return {
    ok: result.exitCode === 0,
    output: result.stderr.toString().trim(),
  };
}

function runScript(
  pkg: WorkspacePackage,
  script: string,
  root: string,
  report: CheckReport,
): void {
  if (pkg.packageJson.scripts?.[script] === undefined) {
    report.notes.push(`${pkg.dir}: no ${script} script.`);
    return;
  }
  const result = run(["bun", "run", script], path.join(root, pkg.dir));
  if (!result.ok) {
    report.violations.push(
      `${pkg.dir}: "${script}" fails when run from the package ` +
        `directory. A package must ${script === "build" ? "build" : "pass"} ` +
        `in isolation, not only through the workspace fan-out.\n${result.output}`,
    );
  }
}

function linkDependency(
  dependency: string,
  pkg: WorkspacePackage,
  root: string,
  workspaceDirs: ReadonlyMap<string, string>,
  stageModules: string,
): string | null {
  const candidates = [
    path.join(root, pkg.dir, "node_modules", dependency),
    path.join(root, "node_modules", dependency),
    workspaceDirs.get(dependency) ?? "",
  ];
  const source = candidates.find(
    (candidate) => candidate.length > 0 && existsSync(candidate),
  );
  if (source === undefined) {
    return (
      `${pkg.dir}: declared dependency "${dependency}" is not ` +
      `installed anywhere in the workspace.`
    );
  }
  const target = path.join(stageModules, dependency);
  mkdirSync(path.dirname(target), { recursive: true });
  symlinkSync(source, target, "dir");
  return null;
}

function checkPackedConsumption(
  pkg: WorkspacePackage,
  root: string,
  workspaceDirs: ReadonlyMap<string, string>,
  report: CheckReport,
): void {
  const name = pkg.packageJson.name;
  const version = pkg.packageJson.version;
  if (name === undefined || version === undefined) {
    report.violations.push(
      `${pkg.dir}: package.json needs both name and version to be ` +
        `consumable as a published package.`,
    );
    return;
  }
  const stage = mkdtempSync(path.join(tmpdir(), "check-packages-"));
  try {
    const packResult = run(
      ["bun", "pm", "pack", "--destination", stage],
      path.join(root, pkg.dir),
    );
    if (!packResult.ok) {
      report.violations.push(
        `${pkg.dir}: bun pm pack failed.\n${packResult.output}`,
      );
      return;
    }
    const tarball = path.join(stage, tarballNameFor(name, version));
    const extractResult = run(["tar", "-xzf", tarball, "-C", stage], stage);
    if (!extractResult.ok) {
      report.violations.push(
        `${pkg.dir}: packed tarball could not be extracted.\n` +
          extractResult.output,
      );
      return;
    }
    const installedDir = path.join(stage, "node_modules", name);
    mkdirSync(path.dirname(installedDir), { recursive: true });
    renameSync(path.join(stage, "package"), installedDir);

    let broken = false;
    for (const target of collectExportTargets(pkg.packageJson.exports)) {
      if (existsSync(path.join(installedDir, target))) continue;
      report.violations.push(
        `${pkg.dir}: exports promises "${target}" but the packed ` +
          `artifact does not contain it — a published install would ` +
          `not resolve it. Fix the exports map or the files field.`,
      );
      broken = true;
    }
    for (const dependency of declaredDependencyNames(pkg.packageJson)) {
      const problem = linkDependency(
        dependency,
        pkg,
        root,
        workspaceDirs,
        path.join(stage, "node_modules"),
      );
      if (problem !== null) {
        report.violations.push(problem);
        broken = true;
      }
    }
    if (broken) return;

    const importResult = run(
      ["bun", "-e", `await import(${JSON.stringify(name)});`],
      stage,
    );
    if (!importResult.ok) {
      report.violations.push(
        `${pkg.dir}: the packed artifact does not import by name from ` +
          `outside the workspace with only its declared dependencies ` +
          `present — an undeclared dependency or a file missing from ` +
          `the pack.\n${importResult.output}`,
      );
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  const report = emptyReport();
  const packages = await listWorkspacePackages(root);
  const workspaceDirs = new Map<string, string>();
  for (const pkg of packages) {
    if (pkg.packageJson.name !== undefined) {
      workspaceDirs.set(pkg.packageJson.name, path.join(root, pkg.dir));
    }
  }
  for (const pkg of packages) {
    runScript(pkg, "build", root, report);
    runScript(pkg, "test", root, report);
    if (pkg.packageJson.exports === undefined) {
      report.notes.push(
        `${pkg.dir}: no exports field; skipping packed-consumption check.`,
      );
      continue;
    }
    checkPackedConsumption(pkg, root, workspaceDirs, report);
  }
  if (packages.length === 0) {
    report.notes.push("no workspace packages yet.");
  }
  reportAndExit("check:packages", report);
}

if (import.meta.main) await main();
