// check:catalog-pins — a dependency declared in the root `catalog` must be
// consumed as `catalog:` everywhere. A literal range for a catalogued
// dependency is how the same package ends up pinned two ways (CL-7442
// found drizzle-orm, hono, postgres, and @types/react-dom drifted this
// way) — one workspace bumps its own literal, the rest don't, and the
// version actually installed depends on hoisting order.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
] as const;

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  catalog?: Record<string, string>;
}

const WORKSPACE_GLOBS = [
  "apps/*/package.json",
  "packages/*/package.json",
  "tools/*/package.json",
  "templates/package.json",
  "vendor/intx/*/package.json",
  "workflows/*/package.json",
];

export function auditCatalogPins(
  catalog: Readonly<Record<string, string>>,
  workspaces: readonly { dir: string; packageJson: PackageJson }[],
): CheckReport {
  const report = emptyReport();
  const catalogued = new Set(Object.keys(catalog));

  for (const { dir, packageJson } of workspaces) {
    for (const field of DEPENDENCY_FIELDS) {
      const deps = packageJson[field];
      if (!deps) continue;
      for (const [name, range] of Object.entries(deps)) {
        if (!catalogued.has(name)) continue;
        if (range === "catalog:") continue;
        report.violations.push(
          `${dir}/package.json: "${name}" is declared in the root catalog ` +
            `but pinned here as a literal ("${range}") instead of ` +
            `"catalog:" — either use "catalog:" or drop the entry from the ` +
            `root catalog if this package intentionally needs a different ` +
            `version.`,
        );
      }
    }
  }
  return report;
}

async function listWorkspaces(
  root: string,
): Promise<{ dir: string; packageJson: PackageJson }[]> {
  const workspaces: { dir: string; packageJson: PackageJson }[] = [];
  for (const pattern of WORKSPACE_GLOBS) {
    const glob = new Glob(pattern);
    for await (const manifestPath of glob.scan(root)) {
      const dir = path.dirname(manifestPath);
      const packageJson = JSON.parse(
        readFileSync(path.join(root, manifestPath), "utf8"),
      ) as PackageJson;
      workspaces.push({ dir, packageJson });
    }
  }
  return workspaces;
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  const rootPackageJsonPath = path.join(root, "package.json");
  const rootPackageJson = existsSync(rootPackageJsonPath)
    ? (JSON.parse(readFileSync(rootPackageJsonPath, "utf8")) as PackageJson)
    : {};
  const catalog = rootPackageJson.catalog ?? {};
  const workspaces = await listWorkspaces(root);
  const report = auditCatalogPins(catalog, workspaces);
  if (workspaces.length === 0) {
    report.notes.push("no workspace packages yet.");
  }
  reportAndExit("check:catalog-pins", report);
}

if (import.meta.main) await main();
