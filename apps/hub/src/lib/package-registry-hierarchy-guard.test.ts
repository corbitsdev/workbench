import { describe, expect, it, mock } from "bun:test";
import { AssetServiceError, type AssetService } from "@intx/hub-sessions";
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
    return { ok: false as const, reason: "unexpected" };
  },
);

mock.module("@intx/hub-sessions", () => ({
  AssetServiceError,
  validateTarballPackageJSON,
}));

const {
  PackageRegistryHierarchyCollisionError,
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

  it("throws when two assets publish the same name@version with different bytes", async () => {
    await expect(
      assertNoCrossAssetPackageRegistryCollisions({
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
      }),
    ).rejects.toBeInstanceOf(PackageRegistryHierarchyCollisionError);
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
