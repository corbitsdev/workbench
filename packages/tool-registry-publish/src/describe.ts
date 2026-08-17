// Static description of every published `@corbits/*-tools` package's
// tool surface, read by importing each package's own `src/index.ts`
// module (the pre-bundle source, not the packed tarball). The hub's
// folded-run launch composition (`apps/hub/src/index.ts`) uses this to
// derive the `tool:<qualifiedId>` grants a launch's pinned packages
// need — see `@corbits/folded-runs`'s `ToolGrantsForPins` for why those
// grants have to be minted at deploy time rather than left to the
// deploy-time capability walk, which only covers inline tool factories.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type } from "arktype";
import { CORBITS_TOOL_PACKAGE_DIRS } from "./registry";

const PackageManifest = type({
  name: "string",
  version: "string",
});

/** Structural shape of an `AnnotatedToolFactory` export, checked by duck type rather than `instanceof` since the loaded module crosses a dynamic `import()` boundary. */
type Bundle = {
  readonly id: string;
  readonly definitions: readonly {
    readonly name: string;
    readonly approval?: "ask";
  }[];
};

function isBundle(value: unknown): value is Bundle {
  return (
    typeof value === "function" &&
    typeof (value as { id?: unknown }).id === "string" &&
    Array.isArray((value as { definitions?: unknown }).definitions)
  );
}

export type CorbitsToolPackageTool = {
  readonly qualifiedId: string;
  readonly approval?: "ask";
};

export type CorbitsToolPackageDescription = {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly CorbitsToolPackageTool[];
};

async function describeOnePackage(
  dir: string,
): Promise<CorbitsToolPackageDescription> {
  const manifestJson: unknown = JSON.parse(
    await readFile(path.join(dir, "package.json"), "utf8"),
  );
  const manifest = PackageManifest(manifestJson);
  if (manifest instanceof type.errors) {
    throw new Error(
      `describeCorbitsToolPackages: ${dir}'s package.json failed validation: ${manifest.summary}`,
    );
  }

  const mod = (await import(path.join(dir, "src", "index.ts"))) as Record<
    string,
    unknown
  >;
  const bundles = Object.values(mod).filter(isBundle);
  const tools: CorbitsToolPackageTool[] = [];
  for (const bundle of bundles) {
    for (const definition of bundle.definitions) {
      tools.push({
        qualifiedId: `${bundle.id}:${definition.name}`,
        ...(definition.approval !== undefined
          ? { approval: definition.approval }
          : {}),
      });
    }
  }
  return { name: manifest.name, version: manifest.version, tools };
}

// Every corbits tool package's module graph is static for this
// process's lifetime (its source only changes across a restart), so
// the description is computed once and reused — mirrors `pack.ts`'s
// own `packCache` reasoning for the same source directories.
let cached: Promise<readonly CorbitsToolPackageDescription[]> | undefined;

/**
 * Describe every `@corbits/*-tools` package's exported tool bundles:
 * each bundle's namespaced tool id (`<bundle.id>:<definition.name>`,
 * the exact shape the workflow child's authz gate matches — see
 * `vendor/intx/tool-packaging/src/loader.ts`'s `applyNamespacePrefix`)
 * and its static approval mark.
 */
export function describeCorbitsToolPackages(): Promise<
  readonly CorbitsToolPackageDescription[]
> {
  cached ??= Promise.all(CORBITS_TOOL_PACKAGE_DIRS.map(describeOnePackage));
  return cached;
}
