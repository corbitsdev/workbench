// Pack Workbench's `@workbench/tools-*` packages into deterministic,
// self-contained npm-style tarballs under `dist/tool-packages/` for the
// `package-registry` asset. Mirrors interchange's `bin/build-builtins.ts`,
// whose BUILTINS list is @intx-only and whose packer is not exported.
// See docs/CREATING_AGENTS_AND_TOOLS.md.

import { promises as fs } from "node:fs";
import path from "node:path";
import * as tar from "tar";
import ssri from "ssri";
import { type } from "arktype";

import { PackageJSON } from "@intx/types/package-json";

export interface ToolPackageSpec {
  /** npm package name as it appears in `package.json#name`. */
  name: string;
  /** Workspace-relative path to the package root. */
  packageDir: string;
}

export interface BuiltToolPackage {
  name: string;
  version: string;
  integrity: string;
  tarballPath: string;
}

// The Workbench tool packages distributed through the registry. Adding a
// package means appending here, declaring `interchange.tools` in the
// package, and pinning it on whichever agent definition wants it.
export const TOOL_PACKAGES: ToolPackageSpec[] = [
  {
    name: "@workbench/tools-ab-compare",
    packageDir: "packages/tools-ab-compare",
  },
  { name: "@workbench/tools-artifact", packageDir: "packages/tools-artifact" },
  { name: "@workbench/tools-agents", packageDir: "packages/tools-agents" },
  { name: "@workbench/tools-skills", packageDir: "packages/tools-skills" },
  { name: "@workbench/tools-dispatch", packageDir: "packages/tools-dispatch" },
  {
    name: "@workbench/tools-hackernews",
    packageDir: "packages/tools-hackernews",
  },
  {
    name: "@workbench/tools-polymarket",
    packageDir: "packages/tools-polymarket",
  },
  {
    name: "@workbench/tools-last30days",
    packageDir: "packages/tools-last30days",
  },
  {
    name: "@workbench/tools-firecrawl",
    packageDir: "packages/tools-firecrawl",
  },
  { name: "@workbench/tools-exa", packageDir: "packages/tools-exa" },
  { name: "@workbench/tools-granola", packageDir: "packages/tools-granola" },
  { name: "@workbench/tools-reddit", packageDir: "packages/tools-reddit" },
  { name: "@workbench/tools-x", packageDir: "packages/tools-x" },
  {
    name: "@workbench/tools-scrapecreators",
    packageDir: "packages/tools-scrapecreators",
  },
  { name: "@workbench/tools-github", packageDir: "packages/tools-github" },
  { name: "@workbench/tools-youtube", packageDir: "packages/tools-youtube" },
  { name: "@workbench/tools-bluesky", packageDir: "packages/tools-bluesky" },
  { name: "@workbench/tools-gamma", packageDir: "packages/tools-gamma" },
  { name: "@workbench/tools-linear", packageDir: "packages/tools-linear" },
  { name: "@workbench/tools-attio", packageDir: "packages/tools-attio" },
  { name: "@workbench/tools-vercel", packageDir: "packages/tools-vercel" },
];

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "dist", "tool-packages");

const NPM_PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function assertValidPackageName(pkgName: string): void {
  if (!NPM_PACKAGE_NAME_PATTERN.test(pkgName)) {
    throw new Error(
      `${pkgName} is not a valid npm package name (expected lowercase, optional \`@scope/\` prefix, URL-safe characters)`,
    );
  }
}

// Flatten `@scope/tail` → `@scope-tail` so scoped packages with
// colliding tails stay distinct on disk; the leading `@` and internal
// `-` both pass the kind handler's tarball-filename pattern.
function tarballBaseName(pkgName: string): string {
  assertValidPackageName(pkgName);
  if (!pkgName.startsWith("@")) return pkgName;
  const slash = pkgName.indexOf("/");
  if (slash === -1 || slash === pkgName.length - 1) {
    throw new Error(`scoped package name missing trailing segment: ${pkgName}`);
  }
  return `${pkgName.slice(0, slash)}-${pkgName.slice(slash + 1)}`;
}

async function readPackageJSON(packageDir: string): Promise<PackageJSON> {
  const absPkgDir = path.join(REPO_ROOT, packageDir);
  const raw = await fs.readFile(path.join(absPkgDir, "package.json"), "utf-8");
  const parsed: unknown = JSON.parse(raw);
  const validated = PackageJSON(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `${packageDir}/package.json did not match expected shape: ${validated.summary}`,
    );
  }
  return validated;
}

function deriveSourceFromOutput(outRel: string): string {
  const normalized = outRel.startsWith("./") ? outRel.slice(2) : outRel;
  if (!normalized.startsWith("dist/")) {
    throw new Error(
      `interchange.tools is "${outRel}"; expected a "./dist/<name>.js" path`,
    );
  }
  if (!normalized.endsWith(".js")) {
    throw new Error(
      `interchange.tools is "${outRel}"; expected a ".js" suffix on the packed output`,
    );
  }
  const stem = normalized.slice("dist/".length, -".js".length);
  return `./src/${stem}.ts`;
}

// Bundle the package's `interchange.tools` source entry into a single
// self-contained ESM file so the published tarball runs on bare Node
// with no workspace/catalog deps to resolve.
async function bundleInterchangeEntry(args: {
  absPkgDir: string;
  sourceRel: string;
  outRel: string;
  packageStaging: string;
}): Promise<void> {
  const entryAbs = path.resolve(args.absPkgDir, args.sourceRel);
  const pkgDirAbs = path.resolve(args.absPkgDir);
  const pkgPrefix = pkgDirAbs.endsWith(path.sep)
    ? pkgDirAbs
    : pkgDirAbs + path.sep;
  if (entryAbs !== pkgDirAbs && !entryAbs.startsWith(pkgPrefix)) {
    throw new Error(
      `bundleInterchangeEntry: sourceRel ${JSON.stringify(args.sourceRel)} escapes the package directory ${JSON.stringify(pkgDirAbs)}`,
    );
  }
  await fs.access(entryAbs);
  const outAbs = path.resolve(args.packageStaging, args.outRel);
  await fs.mkdir(path.dirname(outAbs), { recursive: true });

  const result = await Bun.build({
    entrypoints: [entryAbs],
    outdir: path.dirname(outAbs),
    naming: path.basename(outAbs),
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    const messages = result.logs
      .map((log) => (log instanceof Error ? log.message : String(log)))
      .join("\n");
    throw new Error(
      `Bun.build failed for ${args.sourceRel}:\n${messages || "(no diagnostics)"}`,
    );
  }
}

async function copyPackageTree(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === "tsconfig.tsbuildinfo" ||
      entry.name === "dist" ||
      entry.name.endsWith(".test.ts")
    ) {
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyPackageTree(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function listFilesSorted(cwd: string, root: string): Promise<string[]> {
  const acc: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = path.join(cwd, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childRel = path.join(rel, entry.name);
      acc.push(childRel);
      if (entry.isDirectory()) {
        await walk(childRel);
      }
    }
  }
  acc.push(root);
  await walk(root);
  return acc;
}

async function normalizeStagingModes(
  cwd: string,
  entries: string[],
): Promise<void> {
  for (const rel of entries) {
    const abs = path.join(cwd, rel);
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      await fs.chmod(abs, 0o755);
    } else if (stat.isFile()) {
      await fs.chmod(abs, 0o644);
    }
  }
}

async function packToolPackage(
  spec: ToolPackageSpec,
  pkg: PackageJSON,
  outDir: string,
): Promise<BuiltToolPackage> {
  const tarballName = `${tarballBaseName(spec.name)}-${pkg.version}.tgz`;
  const stagingDir = path.join(
    outDir,
    ".staging",
    `${spec.name.replace("/", "_")}-${pkg.version}`,
  );
  const packageStaging = path.join(stagingDir, "package");
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(packageStaging, { recursive: true });

  const absPkgDir = path.join(REPO_ROOT, spec.packageDir);
  await copyPackageTree(absPkgDir, packageStaging);

  const outRel = pkg.interchange?.tools;
  if (outRel === undefined) {
    throw new Error(
      `${spec.name} package.json has no interchange.tools field — it cannot be a tool package`,
    );
  }
  const sourceRel = deriveSourceFromOutput(outRel);
  await bundleInterchangeEntry({
    absPkgDir,
    sourceRel,
    outRel,
    packageStaging,
  });

  // Inline everything: drop the workspace/catalog dependency specs the
  // closure resolver cannot satisfy (the bundle carries their code) and
  // the `exports` map so the tarball loads only through the tool-package
  // loader.
  const packedPkgJson: Record<string, unknown> = { ...pkg };
  packedPkgJson.interchange = { tools: outRel };
  delete packedPkgJson.dependencies;
  delete packedPkgJson.devDependencies;
  delete packedPkgJson.optionalDependencies;
  delete packedPkgJson.peerDependencies;
  delete packedPkgJson.exports;
  delete packedPkgJson.scripts;
  await fs.writeFile(
    path.join(packageStaging, "package.json"),
    JSON.stringify(packedPkgJson, null, 2),
  );

  const tarballPath = path.join(outDir, tarballName);
  const tarEntries = await listFilesSorted(stagingDir, "package");
  await normalizeStagingModes(stagingDir, tarEntries);
  const createOpts: tar.TarOptionsWithAliasesAsyncFile = {
    cwd: stagingDir,
    gzip: true,
    file: tarballPath,
    portable: true,
    mtime: new Date(0),
    noDirRecurse: true,
  };
  await tar.create(createOpts, tarEntries);
  await fs.rm(stagingDir, { recursive: true, force: true });

  const bytes = await fs.readFile(tarballPath);
  const integrity = ssri.fromData(bytes, { algorithms: ["sha512"] }).toString();

  return {
    name: spec.name,
    version: pkg.version,
    integrity,
    tarballPath: path.relative(REPO_ROOT, tarballPath),
  };
}

/**
 * Pack every spec into `outDir`. Idempotent: re-running overwrites the
 * artifacts. Returns one record per produced tarball.
 */
export async function buildToolPackages(
  specs: readonly ToolPackageSpec[] = TOOL_PACKAGES,
  outDir: string = DEFAULT_OUT_DIR,
): Promise<BuiltToolPackage[]> {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const seenFilenames = new Set<string>();
  const built: BuiltToolPackage[] = [];
  for (const spec of specs) {
    const pkg = await readPackageJSON(spec.packageDir);
    const expected = `${tarballBaseName(spec.name)}-${pkg.version}.tgz`;
    if (seenFilenames.has(expected)) {
      throw new Error(
        `tool-package tarball filename collision: ${expected} would be produced by more than one spec`,
      );
    }
    seenFilenames.add(expected);
    built.push(await packToolPackage(spec, pkg, outDir));
  }
  return built;
}

if (import.meta.main) {
  const built = await buildToolPackages();
  for (const entry of built) {
    process.stdout.write(
      `  ${entry.name}@${entry.version} → ${entry.tarballPath} (${entry.integrity})\n`,
    );
  }
}
