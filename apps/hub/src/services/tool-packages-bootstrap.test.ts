import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssri from "ssri";

const putTarballSpy =
  mock<
    (...args: unknown[]) => Promise<{ commitSha: string; integrity: string }>
  >();

mock.module("../lib/package-registry-tarball-upload", () => ({
  putPackageRegistryTarball: putTarballSpy,
}));

const createAssetSpy =
  mock<
    (...args: unknown[]) => Promise<{ id: string; kind: string; name: string }>
  >();
const readBlobSpy = mock<(...args: unknown[]) => Promise<Uint8Array>>();

mock.module("@intx/hub-sessions", () => ({
  AssetServiceError: class AssetServiceError extends Error {
    constructor(
      readonly reason: string,
      message: string,
    ) {
      super(message);
      this.name = "AssetServiceError";
    }
  },
  WORKSPACE_BUILTINS_REGISTRY: "workbench-builtins",
}));

let assetRow: { id: string } | null = null;

mock.module("@intx/db", () => ({
  schema: {
    asset: {
      id: "asset.id",
      tenantId: "asset.tenantId",
      kind: "asset.kind",
      name: "asset.name",
    },
  },
}));

mock.module("drizzle-orm", () => ({
  eq: (col: string, value: string) => ({ op: "eq", col, value }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
}));

const { publishEmbeddedToolPackages } = await import(
  "./tool-packages-bootstrap"
);

function makeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(assetRow ? [assetRow] : []),
        }),
      }),
    }),
  };
}

let fixtureDir: string;
const tarballBytes = new Uint8Array([1, 2, 3, 4]);
let embeddedIntegrity: string;

beforeEach(async () => {
  putTarballSpy.mockReset();
  putTarballSpy.mockResolvedValue({
    commitSha: "sha1",
    integrity: "sha512-abc",
  });
  createAssetSpy.mockReset();
  createAssetSpy.mockResolvedValue({
    id: "ast_reg",
    kind: "package-registry",
    name: "workbench-builtins",
  });
  readBlobSpy.mockReset();
  assetRow = { id: "ast_reg" };
  embeddedIntegrity = ssri
    .fromData(tarballBytes, { algorithms: ["sha512"] })
    .toString();

  fixtureDir = await mkdtemp(join(tmpdir(), "tool-bootstrap-"));
  await mkdir(join(fixtureDir, "tarballs"), { recursive: true });
  await writeFile(join(fixtureDir, "tarballs", "pkg.tgz"), tarballBytes);
  await writeFile(
    join(fixtureDir, "manifest.json"),
    JSON.stringify([
      {
        name: "@workbench/tools-demo",
        version: "1.0.0",
        integrity: embeddedIntegrity,
        tarballFilename: "pkg.tgz",
      },
    ]),
  );
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("publishEmbeddedToolPackages", () => {
  it("skips when disabled", async () => {
    await publishEmbeddedToolPackages({
      db: makeDb() as never,
      repoStore: {} as never,
      assetService: {
        createAsset: createAssetSpy,
        readAssetBlob: readBlobSpy,
      } as never,
      rootTenantId: "ten_root",
      enabled: false,
      registryName: "workbench-builtins",
      buildSha: null,
      embeddedDir: fixtureDir,
    });
    expect(putTarballSpy).not.toHaveBeenCalled();
  });

  it("uploads when registry tarball is missing", async () => {
    readBlobSpy.mockRejectedValue(
      new Error('package-registry asset has no blob at "tarballs/pkg.tgz"'),
    );

    await publishEmbeddedToolPackages({
      db: makeDb() as never,
      repoStore: {} as never,
      assetService: {
        createAsset: createAssetSpy,
        readAssetBlob: readBlobSpy,
      } as never,
      rootTenantId: "ten_root",
      enabled: true,
      registryName: "workbench-builtins",
      buildSha: "abc123",
      embeddedDir: fixtureDir,
    });

    expect(putTarballSpy).toHaveBeenCalledTimes(1);
    expect(putTarballSpy.mock.calls[0]?.[0]).toMatchObject({
      assetId: "ast_reg",
      filename: "pkg.tgz",
    });
  });

  it("skips upload when registry integrity matches embedded manifest", async () => {
    readBlobSpy.mockResolvedValue(tarballBytes);

    await publishEmbeddedToolPackages({
      db: makeDb() as never,
      repoStore: {} as never,
      assetService: {
        createAsset: createAssetSpy,
        readAssetBlob: readBlobSpy,
      } as never,
      rootTenantId: "ten_root",
      enabled: true,
      registryName: "workbench-builtins",
      buildSha: null,
      embeddedDir: fixtureDir,
    });

    expect(putTarballSpy).not.toHaveBeenCalled();
  });
});
