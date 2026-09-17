// Shared plumbing for deploy-compatibility auditing (CL-8167): finds every
// workspace package and splits it into publishable (not `private`) vs.
// still-private, the same way scripts/checks/publishable-workflows.ts
// scopes its audit. Computed from package.json files on disk — never
// hand-typed — so a package flipping `private` never silently drifts out
// of sync with what the check expects.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";

export const WORKSPACE_GLOBS = [
  "apps/*/package.json",
  "packages/*/package.json",
  "templates/package.json",
  "tools/*/package.json",
  "workflows/*/package.json",
];

export interface WorkspacePackage {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  /** Names from `dependencies` + `peerDependencies`, workspace or not. */
  readonly deps: readonly string[];
}

export async function listWorkspacePackages(root: string): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (const pattern of WORKSPACE_GLOBS) {
    const glob = new Glob(pattern);
    for await (const manifestPath of glob.scan(root)) {
      const dir = path.dirname(manifestPath);
      const raw = JSON.parse(readFileSync(path.join(root, manifestPath), "utf8"));
      if (typeof raw.name !== "string") continue;
      const deps = {
        ...(raw.dependencies ?? {}),
        ...(raw.peerDependencies ?? {}),
      };
      packages.push({
        dir,
        name: raw.name,
        version: typeof raw.version === "string" ? raw.version : "0.0.0",
        private: raw.private === true,
        deps: Object.keys(deps),
      });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A package is unpublishable when it's `private` itself, or when it
 * depends (directly or transitively) on a package that is — a published
 * tarball of it could never install that dependency. Computed to a
 * fixpoint so the effect propagates, e.g. A depends on B depends on
 * private C: both A and B are unpublishable.
 */
export async function listUnpublishablePackageNames(root: string): Promise<string[]> {
  const packages = await listWorkspacePackages(root);
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const unpublishable = new Set(packages.filter((pkg) => pkg.private).map((pkg) => pkg.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const pkg of packages) {
      if (unpublishable.has(pkg.name)) continue;
      for (const dep of pkg.deps) {
        if (!byName.has(dep)) continue;
        if (unpublishable.has(dep)) {
          unpublishable.add(pkg.name);
          changed = true;
          break;
        }
      }
    }
  }
  return [...unpublishable].sort();
}

export async function listPublishablePackages(root: string): Promise<WorkspacePackage[]> {
  const unpublishable = new Set(await listUnpublishablePackageNames(root));
  return (await listWorkspacePackages(root)).filter((pkg) => !unpublishable.has(pkg.name));
}
