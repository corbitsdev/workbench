import ssri from "ssri";
import {
  DEFAULT_ASSET_REF,
  TARBALLS_PREFIX,
  asTarballEntry,
  type Principal,
  type RepoStore,
} from "@workbench/hub-sessions";

const HUB_PRINCIPAL: Principal = { kind: "hub" };

export class InvalidPackageRegistryTarballFilenameError extends Error {
  constructor(readonly filename: string) {
    super(
      `Invalid package-registry tarball filename ${JSON.stringify(filename)}`,
    );
    this.name = "InvalidPackageRegistryTarballFilenameError";
  }
}

/**
 * Upload (or overwrite) one tarball under a package-registry asset repo.
 * Same write path as the hub asset REST `PUT .../tarballs/:filename` handler.
 */
export async function putPackageRegistryTarball(args: {
  repoStore: RepoStore;
  assetId: string;
  filename: string;
  bytes: Uint8Array;
}): Promise<{ commitSha: string; integrity: string }> {
  const tarballPath = `${TARBALLS_PREFIX}${args.filename}`;
  if (asTarballEntry(tarballPath) === null) {
    throw new InvalidPackageRegistryTarballFilenameError(args.filename);
  }
  const integrity = ssri
    .fromData(args.bytes, { algorithms: ["sha512"] })
    .toString();
  const { commitSha } = await args.repoStore.writeTreePreservingPrefix(
    HUB_PRINCIPAL,
    { kind: "package-registry", id: args.assetId },
    DEFAULT_ASSET_REF,
    {
      preservePrefix: TARBALLS_PREFIX,
      merge: async (existing) => {
        const files: Record<string, Uint8Array> = {};
        for (const [p, blob] of existing) {
          files[p] = blob;
        }
        files[tarballPath] = args.bytes;
        return files;
      },
      message: `Upload ${args.filename}`,
    },
  );
  return { commitSha, integrity };
}
