import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type } from "arktype";
import { PackageJSON } from "@intx/types/package-json";
import {
  parseToolManifestFile,
  sortFactoryManifests,
  type ToolFactoryManifest,
  type ToolManifestIndex,
} from "@workbench/tool-manifest";

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

const InterchangeManifest = type({
  "manifest?": "string",
  "tools?": "string",
});

function packageHasManifest(packageJsonPath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
    const interchange = (raw as { interchange?: { manifest?: string } })
      .interchange;
    return typeof interchange?.manifest === "string";
  } catch {
    return false;
  }
}

export function discoverToolPackageDirs(): string[] {
  const packagesDir = toolManifestPackagesDir();
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("tools-"))
    .map((e) => join(packagesDir, e.name))
    .filter((dir) => {
      const pkgJson = join(dir, "package.json");
      return existsSync(pkgJson) && packageHasManifest(pkgJson);
    })
    .sort();
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

export async function collectToolFactoryManifests(): Promise<
  ToolFactoryManifest[]
> {
  const dirs = discoverToolPackageDirs();
  const factories: ToolFactoryManifest[] = [];
  for (const dir of dirs) {
    const loaded = await loadPackageManifest(dir);
    factories.push(...loaded);
  }
  return sortFactoryManifests(factories);
}

export async function buildToolManifestIndex(): Promise<ToolManifestIndex> {
  const factories = await collectToolFactoryManifests();
  return {
    generatedAt: new Date().toISOString(),
    factories,
  };
}

async function main(): Promise<void> {
  const index = await buildToolManifestIndex();
  const outPath = toolManifestIndexPath();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  process.stdout.write(
    `build-tool-manifests: wrote ${index.factories.length} factories to ${outPath}\n`,
  );
}

if (import.meta.main) {
  await main();
}
