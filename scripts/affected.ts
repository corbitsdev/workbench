// Resolves which workspace packages a change actually affects, so a local
// gate can check those instead of all 109.
//
// A package is affected when the change touches its own files, or when it
// depends -- at any depth -- on a package that was touched. Dependents matter
// as much as the package itself: editing an exported type in
// `@corbits/agent-events` breaks its importers, not the package that changed.
//
// Some paths defeat the whole idea. A root manifest, the shared tsconfig, or
// the runner itself can change the result of every job, and no dependency edge
// records that. Those force a full run rather than a wrong-but-fast one --
// a filtered gate that misses a break is worse than a slow one.
import { Glob } from "bun";

const WORKSPACE_ROOTS = [
  "apps",
  "packages",
  "tools",
  "workflows",
  "vendor/intx",
] as const;

/** Changes whose blast radius no dependency edge can express. */
const GLOBAL_PATHS = [
  "package.json",
  "bun.lock",
  "tsconfig.base.json",
  "tsconfig.json",
  "eslint.config.ts",
  "scripts/",
  ".github/",
] as const;

export type PackageManifest = {
  readonly name: string;
  readonly dir: string;
  readonly workspaceDeps: readonly string[];
};

export function isGlobalChange(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) =>
    GLOBAL_PATHS.some((global) =>
      global.endsWith("/") ? file.startsWith(global) : file === global,
    ),
  );
}

/**
 * The package that owns a file, as the longest workspace directory prefixing
 * it. Longest wins so a nested workspace root (`vendor/intx/db`) is not
 * shadowed by a shorter one that happens to prefix it.
 */
export function ownerOf(
  file: string,
  manifests: readonly PackageManifest[],
): string | undefined {
  let owner: PackageManifest | undefined;
  for (const manifest of manifests) {
    if (!file.startsWith(`${manifest.dir}/`)) continue;
    if (owner === undefined || manifest.dir.length > owner.dir.length) {
      owner = manifest;
    }
  }
  return owner?.name;
}

export function directlyChanged(
  changedFiles: readonly string[],
  manifests: readonly PackageManifest[],
): Set<string> {
  const changed = new Set<string>();
  for (const file of changedFiles) {
    const owner = ownerOf(file, manifests);
    if (owner !== undefined) changed.add(owner);
  }
  return changed;
}

/**
 * Every package that reaches one of `seeds` through workspace dependencies,
 * plus the seeds. Walks the reverse graph to a fixed point, so a cycle
 * terminates instead of recursing forever.
 */
export function withDependents(
  seeds: ReadonlySet<string>,
  manifests: readonly PackageManifest[],
): Set<string> {
  const dependentsOf = new Map<string, string[]>();
  for (const manifest of manifests) {
    for (const dep of manifest.workspaceDeps) {
      const existing = dependentsOf.get(dep);
      if (existing === undefined) dependentsOf.set(dep, [manifest.name]);
      else existing.push(manifest.name);
    }
  }

  const affected = new Set(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) continue;
    for (const dependent of dependentsOf.get(next) ?? []) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }
  return affected;
}

export function affectedPackages(
  changedFiles: readonly string[],
  manifests: readonly PackageManifest[],
): Set<string> | "all" {
  if (isGlobalChange(changedFiles)) return "all";
  return withDependents(directlyChanged(changedFiles, manifests), manifests);
}

export async function readManifests(): Promise<PackageManifest[]> {
  const manifests: PackageManifest[] = [];
  for (const root of WORKSPACE_ROOTS) {
    const glob = new Glob(`${root}/*/package.json`);
    for await (const manifestPath of glob.scan(".")) {
      const raw = (await Bun.file(manifestPath).json()) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const dir = manifestPath.slice(0, -"/package.json".length);
      const deps = { ...raw.dependencies, ...raw.devDependencies };
      manifests.push({
        name: raw.name ?? dir,
        dir,
        workspaceDeps: Object.entries(deps)
          .filter(([, range]) => range.startsWith("workspace:"))
          .map(([dep]) => dep),
      });
    }
  }
  return manifests;
}
