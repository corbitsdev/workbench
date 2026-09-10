// Reads every packed tarball's tool-surface manifest back out of a
// `corbits-tools` package-registry asset's blob tree — the hub-side
// replacement for importing each package's source (`describe.ts`, now
// gone). Blob access is injected so the hub wires it to its launch-path
// `assetService` wrapper (`apps/hub/src/launch-caches.ts`'s SHA-keyed
// `readAssetBlob`), keeping this module free of hub or vendor imports.
import { getLogger } from "@intx/log";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { type } from "arktype";
import { ToolSurfaceManifest } from "./manifest";

const log = getLogger(["tool-registry-publish", "surface-reader"]);

export type ToolSurfaceBlobSource = {
  /** Lists blob paths under `dir` (repo-root-relative, like `listAssetBlobs`). */
  listBlobs: (dir: string) => Promise<string[]>;
  /** Reads one blob's bytes (repo-root-relative path, like `readAssetBlob`). */
  readBlob: (path: string) => Promise<Uint8Array>;
  /** The asset directory the packed tarballs live under. */
  rootDir: string;
};

/**
 * Opens each `tarballs/*.tgz` blob, extracts its `package/package.json`,
 * and parses it with `ToolSurfaceManifest`. A tarball that carries no
 * valid manifest is skipped with a log line, not a thrown error:
 * registries published before manifests existed still hold such
 * tarballs, and `shouldPublishTarball` never re-uploads an existing
 * `name@version` — so one unreadable blob must not take down every
 * grants read on a registry that can no longer heal itself.
 */
export async function readToolSurfaceManifests(
  source: ToolSurfaceBlobSource,
): Promise<ToolSurfaceManifest[]> {
  const blobs = await source.listBlobs(source.rootDir);
  const tarballPaths = blobs.filter(
    (blob) => blob.startsWith(`${source.rootDir}/`) && blob.endsWith(".tgz"),
  );
  const manifests: ToolSurfaceManifest[] = [];
  for (const blobPath of tarballPaths) {
    const manifest = await manifestFromBlob(blobPath, source);
    if (manifest !== undefined) manifests.push(manifest);
  }
  return manifests;
}

async function manifestFromBlob(
  blobPath: string,
  source: ToolSurfaceBlobSource,
): Promise<ToolSurfaceManifest | undefined> {
  let packageJson: unknown;
  try {
    const bytes = await source.readBlob(blobPath);
    packageJson = await extractTarballPackageJSON(bytes);
  } catch (error) {
    log.warn`skipping ${blobPath}: unreadable tarball (${error instanceof Error ? error.message : String(error)})`;
    return undefined;
  }
  const manifest = ToolSurfaceManifest(packageJson);
  if (manifest instanceof type.errors) {
    log.warn`skipping ${blobPath}: package.json is not a valid tool-surface manifest (${manifest.summary})`;
    return undefined;
  }
  return manifest;
}

async function extractTarballPackageJSON(bytes: Uint8Array): Promise<unknown> {
  const extractDir = await mkdtemp(path.join(tmpdir(), "corbits-surface-"));
  try {
    const tarballPath = path.join(extractDir, "in.tgz");
    await writeFile(tarballPath, bytes);
    await tar.extract({ cwd: extractDir, file: tarballPath });
    return JSON.parse(
      await readFile(path.join(extractDir, "package", "package.json"), "utf8"),
    ) as unknown;
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}
