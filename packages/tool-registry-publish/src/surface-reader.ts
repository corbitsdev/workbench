// Reads every packed tarball's tool-surface manifest back out of a
// `corbits-tools` package-registry asset's blob tree — the hub-side
// replacement for importing each package's source (`describe.ts`, now
// gone). Blob access is injected so the hub wires it to its launch-path
// `assetService` wrapper (`apps/hub/src/launch-caches.ts`'s SHA-keyed
// `readAssetBlob`), keeping this module free of hub or vendor imports.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { type } from "arktype";
import { ToolSurfaceManifest } from "./manifest";

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
 * valid manifest is a publish-boundary defect — the packer writes one —
 * so it throws rather than returning a silently partial list.
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
    const bytes = await source.readBlob(blobPath);
    const packageJson = await extractTarballPackageJSON(bytes);
    const manifest = ToolSurfaceManifest(packageJson);
    if (manifest instanceof type.errors) {
      throw new Error(
        `readToolSurfaceManifests: ${blobPath}'s package.json is not a valid tool-surface manifest: ${manifest.summary}`,
      );
    }
    manifests.push(manifest);
  }
  return manifests;
}

async function extractTarballPackageJSON(
  bytes: Uint8Array,
): Promise<unknown> {
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
