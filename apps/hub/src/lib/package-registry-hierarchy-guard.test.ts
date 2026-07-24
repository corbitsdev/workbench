import { describe, expect, it, mock } from "bun:test";
import { AssetServiceError, type AssetService } from "@workbench/hub-sessions";
import type { HubDb } from "../db";

const validateTarballPackageJSON = mock(
  async (filename: string, _bytes: Uint8Array) => {
    if (filename === "a.tgz") {
      return {
        ok: true as const,
        pkg: { name: "@workbench/tools-a", version: "0.1.0" },
      };
    }
    if (filename === "b.tgz") {
      return {
        ok: true as const,
        pkg: { name: "@workbench/tools-a", version: "0.1.0" },
      };
    }
    if (filename === "corrupt.tgz") {
      return { ok: false as const, reason: "not-a-gzip" };
    }
    return { ok: false as const, reason: "unexpected" };
  },
);

mock.module("@workbench/hub-sessions", () => ({
  AssetServiceError,
  validateTarballPackageJSON,
}));

const {
  PackageRegistryTarballInvalidError,
  assertNoCrossAssetPackageRegistryCollisions,
} = await import("./package-registry-hierarchy-guard");

function makeDb(assets: { id: string; name: string }[]): HubDb {
  return {
    select: () => ({
      from: () => ({
        where: async () => assets.map((a) => ({ id: a.id, name: a.name })),
      }),
    }),
  } as unknown as HubDb;
}

function makeAssetService(handlers: {
  list: Record<string, string[]>;
  bytes: Record<string, Uint8Array>;
}): AssetService {
  return {
    listAssetBlobs: async ({ assetId }) => handlers.list[assetId] ?? [],
    readAssetBlob: async ({ assetId, path }) => {
      const key = `${assetId}:${path}`;
      const blob = handlers.bytes[key];
      if (!blob) {
        throw new AssetServiceError("not_found", `has no blob at ${path}`);
      }
      return blob;
    },
  } as unknown as AssetService;
}

describe("assertNoCrossAssetPackageRegistryCollisions", () => {
  it("no-ops for a single registry asset", async () => {
    await assertNoCrossAssetPackageRegistryCollisions({
      db: makeDb([{ id: "a1", name: "workspace-builtins" }]),
      assetService: makeAssetService({ list: {}, bytes: {} }),
      tenantId: "t1",
    });
  });

  it("returns (does not throw) a warning collision when two assets publish the same name@version with different bytes", async () => {
    const collisions = await assertNoCrossAssetPackageRegistryCollisions({
      db: makeDb([
        { id: "legacy", name: "workbench-builtins" },
        { id: "canon", name: "workspace-builtins" },
      ]),
      assetService: makeAssetService({
        list: {
          legacy: ["a.tgz"],
          canon: ["b.tgz"],
        },
        bytes: {
          "legacy:tarballs/a.tgz": new Uint8Array([1]),
          "canon:tarballs/b.tgz": new Uint8Array([2]),
        },
      }),
      tenantId: "t1",
    });

    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      nameVersion: "@workbench/tools-a@0.1.0",
      assetA: "workbench-builtins",
      assetB: "workspace-builtins",
    });
  });

  it("still throws PackageRegistryTarballInvalidError on a corrupt tarball", async () => {
    await expect(
      assertNoCrossAssetPackageRegistryCollisions({
        db: makeDb([
          { id: "legacy", name: "workbench-builtins" },
          { id: "canon", name: "workspace-builtins" },
        ]),
        assetService: makeAssetService({
          list: {
            legacy: ["corrupt.tgz"],
            canon: ["b.tgz"],
          },
          bytes: {
            "legacy:tarballs/corrupt.tgz": new Uint8Array([1]),
            "canon:tarballs/b.tgz": new Uint8Array([2]),
          },
        }),
        tenantId: "t1",
      }),
    ).rejects.toBeInstanceOf(PackageRegistryTarballInvalidError);
  });

  it("skips a listed tarball when read returns not_found", async () => {
    await assertNoCrossAssetPackageRegistryCollisions({
      db: makeDb([
        { id: "legacy", name: "workbench-builtins" },
        { id: "canon", name: "workspace-builtins" },
      ]),
      assetService: {
        listAssetBlobs: async ({ assetId }) =>
          assetId === "legacy" ? ["stale.tgz"] : [],
        readAssetBlob: async () => {
          throw new AssetServiceError("not_found", "missing blob");
        },
      } as unknown as AssetService,
      tenantId: "t1",
    });
  });

  it("allows the same name@version when integrity matches across assets", async () => {
    const shared = new Uint8Array([9, 9, 9]);
    await assertNoCrossAssetPackageRegistryCollisions({
      db: makeDb([
        { id: "legacy", name: "workbench-builtins" },
        { id: "canon", name: "workspace-builtins" },
      ]),
      assetService: makeAssetService({
        list: {
          legacy: ["a.tgz"],
          canon: ["b.tgz"],
        },
        bytes: {
          "legacy:tarballs/a.tgz": shared,
          "canon:tarballs/b.tgz": shared,
        },
      }),
      tenantId: "t1",
    });
  });
});
