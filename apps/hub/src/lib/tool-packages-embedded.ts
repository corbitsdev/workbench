import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ssri from "ssri";
import { type } from "arktype";

// Tool package rows serialized at build time (CL-3093) and committed under
// `apps/hub/generated/tool-packages/manifest.json` with tarballs in
// `tarballs/*.tgz`, so the hub can sync the registry on boot without
// rebuilding tools at runtime.
export const EmbeddedToolPackageRowSchema = type({
  name: "string",
  version: "string",
  integrity: "string",
  tarballFilename: "string",
});
export type EmbeddedToolPackageRow = typeof EmbeddedToolPackageRowSchema.infer;

export const EmbeddedToolPackageManifestSchema =
  EmbeddedToolPackageRowSchema.array();
export type EmbeddedToolPackageManifest =
  typeof EmbeddedToolPackageManifestSchema.infer;

export function embeddedToolPackagesDir(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "../../generated/tool-packages",
  );
}

/** Same algorithm as `build-tool-packages.ts` when packing tarballs. */
export function integrityFromTarballBytes(bytes: Uint8Array | Buffer): string {
  return ssri.fromData(bytes, { algorithms: ["sha512"] }).toString();
}

export type ToolPackageDriftReason =
  | "missing"
  | "integrity_mismatch"
  | "up_to_date";

export type ToolPackageDriftClassification = {
  action: "upload" | "skip";
  reason: ToolPackageDriftReason;
};

/**
 * Classify whether an embedded manifest row needs upload against a registry blob.
 * `registryBytes` is null when the tarball path is absent in the asset.
 */
export function classifyToolPackageDrift(args: {
  embeddedIntegrity: string;
  registryBytes: Uint8Array | Buffer | null;
}): ToolPackageDriftClassification {
  if (args.registryBytes === null) {
    return { action: "upload", reason: "missing" };
  }
  const live = integrityFromTarballBytes(args.registryBytes);
  if (live !== args.embeddedIntegrity) {
    return { action: "upload", reason: "integrity_mismatch" };
  }
  return { action: "skip", reason: "up_to_date" };
}

export function serializeEmbeddedManifestJson(
  rows: EmbeddedToolPackageManifest,
): string {
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(sorted, null, 2) + "\n";
}
