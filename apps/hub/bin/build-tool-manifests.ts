import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type } from "arktype";
// Resolved via the root devDependency (hoisted `node_modules/prettier`) —
// this script formats its own generated output rather than relying on a
// separate `bun run format` pass, see `renderToolManifestModule` below.
import { format, resolveConfig } from "prettier";
import { PackageJSON } from "@intx/types/package-json";
import {
  assertToolManifestFactoryInvariants,
  parseToolManifestFile,
  sortFactoryManifests,
  type ToolFactoryManifest,
  type ToolManifestIndex,
} from "@workbench/tool-manifest";
import { discoverToolPackageDirs as discoverToolPackageRelativeDirs } from "@workbench/tool-manifest/discover";

function repoRoot(): string {
  const binDir = dirname(fileURLToPath(import.meta.url));
  return dirname(dirname(dirname(binDir)));
}

export function toolManifestPackagesDir(): string {
  return join(repoRoot(), "packages");
}

export function toolManifestIndexPath(): string {
  return join(
    repoRoot(),
    "apps",
    "hub",
    "generated",
    "tool-manifests",
    "index.json",
  );
}

/** Absolute directories of every workspace member that declares `interchange.manifest`. */
export function discoverToolPackageDirs(root: string = repoRoot()): string[] {
  return discoverToolPackageRelativeDirs(root).map((rel) => join(root, rel));
}

async function loadPackageManifest(
  packageDir: string,
): Promise<ToolFactoryManifest[]> {
  const pkgJsonPath = join(packageDir, "package.json");
  const raw = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as unknown;
  const parsed = PackageJSON(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `build-tool-manifests: invalid package.json ${pkgJsonPath}: ${parsed.summary}`,
    );
  }
  const interchange = (parsed as { interchange?: { manifest?: string } })
    .interchange;
  const manifestRel = interchange?.manifest;
  if (manifestRel === undefined) {
    throw new Error(
      `build-tool-manifests: ${pkgJsonPath} missing interchange.manifest`,
    );
  }
  const manifestPath = join(packageDir, manifestRel);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `build-tool-manifests: manifest file missing: ${manifestPath}`,
    );
  }
  const mod = (await import(pathToFileURL(manifestPath).href)) as {
    toolManifestFile?: unknown;
    default?: unknown;
  };
  const candidate = mod.toolManifestFile ?? mod.default;
  const fileParsed = parseToolManifestFile(candidate);
  if (typeof fileParsed === "string") {
    throw new Error(
      `build-tool-manifests: invalid manifest ${manifestPath}: ${fileParsed}`,
    );
  }
  return fileParsed.factories;
}

export async function collectToolFactoryManifests(
  root: string = repoRoot(),
): Promise<ToolFactoryManifest[]> {
  const dirs = discoverToolPackageDirs(root);
  const factories: ToolFactoryManifest[] = [];
  for (const dir of dirs) {
    const loaded = await loadPackageManifest(dir);
    factories.push(...loaded);
  }
  return sortFactoryManifests(factories);
}

// `generatedAt` is a content hash of the sorted factories, not a wall-clock
// timestamp — regenerating from unchanged source must produce byte-identical
// output (both the standalone index.json and the bundled module), which a
// `new Date().toISOString()` value cannot do. Nothing parses this field as a
// date; the schema only requires it to be a string.
function contentDigest(factories: ToolFactoryManifest[]): string {
  return createHash("sha256").update(JSON.stringify(factories)).digest("hex");
}

export async function buildToolManifestIndex(): Promise<ToolManifestIndex> {
  const factories = await collectToolFactoryManifests();
  assertToolManifestFactoryInvariants(factories);
  return {
    generatedAt: contentDigest(factories),
    factories,
  };
}

export function toolManifestModulePath(): string {
  return join(
    repoRoot(),
    "packages",
    "tool-manifest",
    "src",
    "generated",
    "tool-manifest-index.ts",
  );
}

// The module form exists so browser bundles can reach the committed index via
// a static import — a runtime readFileSync of index.json builds green under
// Vite but crashes in the browser (node builtins are shimmed to empty modules).
//
// `generatedAt` is deliberately omitted here: this module is bundled into
// every tool package's dist output, so any per-run value baked in would churn
// tarball bytes (and their sha512 integrity) even with zero source change.
// It still lands in the standalone index.json for human/debug use;
// `loadCommittedToolManifestFactories` never reads it.
//
// The output is run through prettier before being returned. Bun.build does
// NOT normalize object-key quote style away when bundling — a raw
// `JSON.stringify` render (quoted keys) produces different bytes, and thus a
// different sha512 tarball integrity, than the same content after prettier's
// default `quoteProps: "as-needed"` strips the quotes. Formatting here, once,
// at the source of the generated file removes the separate "run format before
// build:tool-packages" step as a footgun — the raw output IS already the
// formatted output, so build order no longer matters.
export async function renderToolManifestModule(
  index: ToolManifestIndex,
): Promise<string> {
  const { factories } = index;
  const raw = [
    "// Generated by `bun run build:tool-manifests` (apps/hub/bin/build-tool-manifests.ts).",
    "// Do not edit — regenerate after changing any package tool manifest.",
    `export const COMMITTED_TOOL_MANIFEST_INDEX: unknown = ${JSON.stringify({ factories }, null, 2)};`,
    "",
  ].join("\n");
  const modulePath = toolManifestModulePath();
  const config = await resolveConfig(modulePath);
  return format(raw, { ...config, filepath: modulePath, parser: "typescript" });
}

async function main(): Promise<void> {
  const index = await buildToolManifestIndex();
  const outPath = toolManifestIndexPath();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  const modulePath = toolManifestModulePath();
  mkdirSync(dirname(modulePath), { recursive: true });
  writeFileSync(modulePath, await renderToolManifestModule(index), "utf8");
  process.stdout.write(
    `build-tool-manifests: wrote ${index.factories.length} factories to ${outPath} and ${modulePath}\n`,
  );
}

if (import.meta.main) {
  await main();
}
