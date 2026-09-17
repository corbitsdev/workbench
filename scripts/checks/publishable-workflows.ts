// check:publishable-workflows — every workflows/* package and every
// packages/*-tools (or packages/tools-*) package must stay an
// individually publishable npm package: a standalone tarball with no
// dependency that only resolves inside this monorepo (CL-8157).
//
// A package opts out of this check entirely by staying `private: true` —
// that's the escape hatch for a package with a runtime dependency this
// repo cannot yet publish around (see the CL-8157 PR description for the
// current list). Once a package drops `private`, this check holds it to
// the full bar: it must declare `exports`, `files`, and `license`, and
// none of its runtime `dependencies` or `peerDependencies` may be a
// `workspace:*` range or point at a package that is itself still
// `private: true`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import { type } from "arktype";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const PackageJson = type({
  name: "string",
  "private?": "boolean",
  "license?": "string",
  "exports?": "unknown",
  "files?": "unknown",
  "dependencies?": "Record<string, string>",
  "peerDependencies?": "Record<string, string>",
});
type PackageJson = typeof PackageJson.infer;

const PUBLISHABLE_GLOBS = [
  "workflows/*/package.json",
  "packages/*/package.json",
];

function isInScope(dir: string): boolean {
  if (dir.startsWith("workflows/")) return true;
  const base = path.basename(dir);
  return base.endsWith("-tools") || base.startsWith("tools-");
}

interface Workspace {
  readonly dir: string;
  readonly packageJson: PackageJson;
}

async function listWorkspaces(root: string): Promise<Workspace[]> {
  const workspaces: Workspace[] = [];
  for (const pattern of PUBLISHABLE_GLOBS) {
    const glob = new Glob(pattern);
    for await (const manifestPath of glob.scan(root)) {
      const dir = path.dirname(manifestPath);
      if (!isInScope(dir)) continue;
      const raw = JSON.parse(
        readFileSync(path.join(root, manifestPath), "utf8"),
      );
      const parsed = PackageJson(raw);
      if (parsed instanceof type.errors) {
        throw new Error(
          `${manifestPath}: invalid package.json — ${parsed.summary}`,
        );
      }
      workspaces.push({ dir, packageJson: parsed });
    }
  }
  return workspaces.sort((a, b) => a.dir.localeCompare(b.dir));
}

export function auditPublishableWorkflows(
  workspaces: readonly Workspace[],
): CheckReport {
  const report = emptyReport();
  const privateNames = new Set(
    workspaces
      .filter((w) => w.packageJson.private === true)
      .map((w) => w.packageJson.name),
  );

  for (const { dir, packageJson } of workspaces) {
    if (packageJson.private === true) continue;

    if (packageJson.license === undefined) {
      report.violations.push(`${dir}/package.json: missing "license".`);
    }
    if (packageJson.exports === undefined) {
      report.violations.push(`${dir}/package.json: missing "exports".`);
    }
    if (packageJson.files === undefined) {
      report.violations.push(`${dir}/package.json: missing "files".`);
    }

    for (const field of ["dependencies", "peerDependencies"] as const) {
      const deps = packageJson[field];
      if (!deps) continue;
      for (const [name, range] of Object.entries(deps)) {
        if (range === "workspace:*" || range.startsWith("workspace:")) {
          report.violations.push(
            `${dir}/package.json: "${field}.${name}" is "${range}" — a ` +
              `workspace: range never survives publish; pin a real version.`,
          );
          continue;
        }
        if (privateNames.has(name)) {
          report.violations.push(
            `${dir}/package.json: "${field}.${name}" points at "${name}", ` +
              `which is still "private: true" — a published tarball of ` +
              `this package can never install it. Either publish "${name}" ` +
              `too, or keep this package private until it can.`,
          );
        }
      }
    }
  }
  return report;
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  const workspaces = await listWorkspaces(root);
  const report = auditPublishableWorkflows(workspaces);
  if (workspaces.length === 0) {
    report.notes.push("no workflows/* or *-tools packages found.");
  }
  reportAndExit("check:publishable-workflows", report);
}

if (import.meta.main) await main();
