// Publishes every `tools/*` package's raw TypeScript source as an
// npm-shaped tarball into the tenant's `corbits-tools` package-registry
// asset — the same ensure-asset-then-PUT-tarball plumbing
// `myra-deploy.ts` already uses for Myra's own workflow source, and the
// same `packTarball` (Interchange's stock tool-package resolver installs
// and runs a tool package straight from its packed source, so no bundling
// step is needed here either). `tools/*` directories are read directly
// off the workspace at build time via `import.meta.glob`, so a new
// `tools/*` package is picked up without editing a directory list here.
import { type } from "arktype";

import { packTarball } from "../myra-deploy";

export const CORBITS_TOOLS_REGISTRY = "corbits-tools";

class RegistryPublishError extends Error {}

async function readErrorBody(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = type({
    error: { code: "string", userMessage: "string", refId: "string" },
  })(body);
  return envelope instanceof type.errors ? `HTTP ${response.status}` : envelope.error.userMessage;
}

const AssetCreatedShape = type({ id: "string" });
const AssetListShape = type({ id: "string", name: "string" }).array();
const TarballPutShape = type({ commit: "string", integrity: "string" });

/** Idempotently ensures the tenant's `corbits-tools` package-registry
 * asset exists, mirroring `myra-deploy.ts`'s `ensureMyraSourceAsset`. */
export async function ensureCorbitsToolsRegistryAsset(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const created = await fetchImpl(`/api/tenants/${encodeURIComponent(tenantId)}/assets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "package-registry", name: CORBITS_TOOLS_REGISTRY }),
  });
  if (created.status === 201) {
    const parsed = AssetCreatedShape(await created.json());
    if (parsed instanceof type.errors) {
      throw new RegistryPublishError(
        `the ${CORBITS_TOOLS_REGISTRY} registry came back an unexpected shape: ${parsed.summary}`,
      );
    }
    return parsed.id;
  }
  if (created.status !== 409) {
    throw new RegistryPublishError(
      `preparing the ${CORBITS_TOOLS_REGISTRY} registry failed: ${await readErrorBody(created)}`,
    );
  }
  const listed = await fetchImpl(
    `/api/tenants/${encodeURIComponent(tenantId)}/assets?kind=package-registry&inherited=false`,
  );
  if (!listed.ok) {
    throw new RegistryPublishError(
      `checking the ${CORBITS_TOOLS_REGISTRY} registry failed: ${await readErrorBody(listed)}`,
    );
  }
  const parsed = AssetListShape(await listed.json());
  if (parsed instanceof type.errors) {
    throw new RegistryPublishError(
      `the ${CORBITS_TOOLS_REGISTRY} registry's asset list came back an unexpected shape: ${parsed.summary}`,
    );
  }
  const existing = parsed.find((asset) => asset.name === CORBITS_TOOLS_REGISTRY);
  if (existing === undefined) {
    throw new RegistryPublishError(
      `the ${CORBITS_TOOLS_REGISTRY} registry reported a name conflict but is not listed on this workbench`,
    );
  }
  return existing.id;
}

// Specifiers that only resolve inside this monorepo's own workspace —
// resolved to the concrete version a published tarball's consumer can
// actually install, taken from the root `catalog` this repo pins them at.
const CATALOG_VERSIONS: Record<string, string> = {
  arktype: "^2.2.0",
  semver: "^7.7.2",
};

function resolvedDependencySpec(packageName: string, spec: string): string {
  if (spec === "catalog:") {
    const resolved = CATALOG_VERSIONS[packageName];
    if (resolved === undefined) {
      throw new RegistryPublishError(
        `registry-publish: no catalog version recorded for "${packageName}" — add it to CATALOG_VERSIONS`,
      );
    }
    return resolved;
  }
  return spec;
}

type ToolPackageManifest = {
  readonly name: string;
  readonly version: string;
  readonly exports?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

export type ToolPackageTarball = { readonly name: string; readonly version: string };

function tarballFilenameFor(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

const TOOL_PACKAGE_MANIFESTS = import.meta.glob("../../../../tools/*/package.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const TOOL_PACKAGE_SOURCE_FILES = import.meta.glob("../../../../tools/*/src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function toolDirName(manifestPath: string): string {
  const match = /\/tools\/([^/]+)\/package\.json$/.exec(manifestPath);
  const dir = match?.[1];
  if (dir === undefined) {
    throw new RegistryPublishError(`registry-publish: unexpected manifest path ${manifestPath}`);
  }
  return dir;
}

/** One `tools/*` package's manifest plus every `src/**\/*.ts` file it
 * ships, staged the same shape `packTarball` expects. */
function buildToolPackageTree(
  manifestPath: string,
  manifestJson: string,
): {
  name: string;
  version: string;
  tree: Record<string, string>;
} {
  const manifest = JSON.parse(manifestJson) as ToolPackageManifest;
  const dependencies = Object.fromEntries(
    Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies }).map(
      ([name, spec]) => [name, resolvedDependencySpec(name, spec)],
    ),
  );
  const dir = toolDirName(manifestPath);
  const prefix = `../../../../tools/${dir}/`;
  const tree: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        type: "module",
        exports: manifest.exports,
        dependencies,
        interchange: { tools: manifest.exports?.["."] ?? "./src/index.ts" },
      },
      null,
      2,
    ),
  };
  for (const [sourcePath, contents] of Object.entries(TOOL_PACKAGE_SOURCE_FILES)) {
    if (!sourcePath.startsWith(prefix)) continue;
    tree[sourcePath.slice(prefix.length)] = contents;
  }
  return { name: manifest.name, version: manifest.version, tree };
}

/** Every `tools/*` package this workspace ships, as the `packTarball`-ready
 * trees `publishToolPackageRegistry` packs and uploads. Exported standalone
 * so the packaging is unit-testable without a fetch round trip. */
export function buildToolPackageTrees(): {
  name: string;
  version: string;
  tree: Record<string, string>;
}[] {
  return Object.entries(TOOL_PACKAGE_MANIFESTS).map(([manifestPath, manifestJson]) =>
    buildToolPackageTree(manifestPath, manifestJson),
  );
}

/** Packs and publishes every `tools/*` package into the tenant's
 * `corbits-tools` registry, ensuring the registry asset first. Returns
 * the filenames it published. */
export async function publishToolPackageRegistry(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolPackageTarball[]> {
  const assetId = await ensureCorbitsToolsRegistryAsset(tenantId, fetchImpl);
  const published: ToolPackageTarball[] = [];
  for (const { name, version, tree } of buildToolPackageTrees()) {
    const tarball = await packTarball(tree);
    const filename = tarballFilenameFor(name, version);
    const response = await fetchImpl(
      `/api/tenants/${encodeURIComponent(tenantId)}/assets/${encodeURIComponent(assetId)}/tarballs/${encodeURIComponent(filename)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Blob([tarball as Uint8Array<ArrayBuffer>]),
      },
    );
    if (!response.ok) {
      throw new RegistryPublishError(`publishing ${name} failed: ${await readErrorBody(response)}`);
    }
    const parsed = TarballPutShape(await response.json());
    if (parsed instanceof type.errors) {
      throw new RegistryPublishError(
        `${name}'s tarball upload came back an unexpected shape: ${parsed.summary}`,
      );
    }
    published.push({ name, version });
  }
  return published;
}
