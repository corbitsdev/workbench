// CL-6149: proves the hub's `toolGrantsForPins` port turns a launch's
// `toolPackagePins` into the exact `tool:<qualifiedId>` grants the
// workflow child's authz gate matches against — derived, since CL-7582,
// from the installed `corbits-tools` asset's packed manifests rather
// than any source import.
import { describe, expect, test } from "bun:test";
import type { AssetWithOrigin } from "@intx/db";
import type {
  AssetService,
  ListAssetBlobsParams,
  ReadAssetBlobParams,
} from "@intx/hub-sessions";
import {
  packToolPackageTarball,
  tarballFilenameFor,
} from "@corbits/tool-registry-publish";
import { createToolGrantsForPins } from "./tool-grants";

async function fakeRegistryAssetService(
  tarballs: Awaited<ReturnType<typeof packToolPackageTarball>>[],
): Promise<Pick<AssetService, "listAssetBlobs" | "readAssetBlob">> {
  const blobs = new Map(
    tarballs.map((tarball) => [
      `tarballs/${tarballFilenameFor(tarball.name, tarball.version)}`,
      tarball.bytes,
    ]),
  );
  return {
    listAssetBlobs: (params: ListAssetBlobsParams) =>
      Promise.resolve(
        [...blobs.keys()].filter((path) => path.startsWith(`${params.dir}/`)),
      ),
    readAssetBlob: (params: ReadAssetBlobParams) => {
      const bytes = blobs.get(params.path);
      if (bytes === undefined) {
        return Promise.reject(new Error(`no ${params.path}`));
      }
      return Promise.resolve(bytes);
    },
  };
}

function assetRow(
  id: string,
  direct: boolean,
): AssetWithOrigin {
  return {
    id,
    name: "corbits-tools",
    origin: { tenantId: "tenant_root", direct },
  } as AssetWithOrigin;
}

const MEMORY_DIR = new URL(
  "../../../packages/memory-tools",
  import.meta.url,
).pathname;
const MANUS_DIR = new URL(
  "../../../packages/manus-tools",
  import.meta.url,
).pathname;

async function grantsFor(
  assetService: Pick<AssetService, "listAssetBlobs" | "readAssetBlob">,
  assets: readonly AssetWithOrigin[],
  pins: readonly { name: string; version: string }[],
) {
  return createToolGrantsForPins({
    listAssets: (tenantId, kind) => {
      expect(tenantId).toBe("tenant_child");
      expect(kind).toBe("package-registry");
      return Promise.resolve(assets);
    },
    assetService,
  })("tenant_child", pins);
}

describe("createToolGrantsForPins", () => {
  test("mints tool:<qualifiedId>/invoke for every tool the installed manifest declares", async () => {
    const assetService = await fakeRegistryAssetService([
      await packToolPackageTarball(MEMORY_DIR),
    ]);
    const grants = await grantsFor(assetService, [assetRow("asset_1", true)], [
      { name: "@corbits/memory-tools", version: "^1" },
    ]);
    expect(grants.map((grant) => grant.resource)).toEqual([
      "tool:@corbits/memory-tools/memory:memory_search",
      "tool:@corbits/memory-tools/memory:memory_add",
      "tool:@corbits/memory-tools/memory:memory_list",
    ]);
    expect(grants.every((grant) => grant.action === "invoke")).toBe(true);
  });

  test("floors an unmarked tool at allow and a `approval: \"ask\"` tool at ask", async () => {
    const assetService = await fakeRegistryAssetService([
      await packToolPackageTarball(MANUS_DIR),
    ]);
    const grants = await grantsFor(assetService, [assetRow("asset_1", true)], [
      { name: "@corbits/manus-tools", version: "*" },
    ]);
    expect(
      grants.find((grant) => grant.resource.endsWith(":webhook_create"))
        ?.effect,
    ).toBe("ask");
    expect(
      grants.find((grant) => grant.resource.endsWith(":create_slides"))
        ?.effect,
    ).toBe("allow");
    expect(
      grants.find((grant) => grant.resource.endsWith(":task_list"))?.effect,
    ).toBe("allow");
  });

  test("unions grants across every pinned package and skips unknown pins", async () => {
    const assetService = await fakeRegistryAssetService([
      await packToolPackageTarball(MEMORY_DIR),
      await packToolPackageTarball(MANUS_DIR),
    ]);
    const grants = await grantsFor(assetService, [assetRow("asset_1", true)], [
      { name: "@corbits/memory-tools", version: "^1" },
      { name: "@corbits/manus-tools", version: "*" },
      { name: "@corbits/unknown-tools", version: "^1" },
    ]);
    expect(
      grants.some((grant) => grant.resource.includes("memory-tools")),
    ).toBe(true);
    expect(
      grants.some((grant) => grant.resource.includes("manus-tools")),
    ).toBe(true);
    expect(grants.some((grant) => grant.resource.includes("unknown"))).toBe(
      false,
    );
  });

  test("resolves an inherited registry, not only a direct one", async () => {
    const assetService = await fakeRegistryAssetService([
      await packToolPackageTarball(MEMORY_DIR),
    ]);
    const grants = await grantsFor(
      assetService,
      [assetRow("asset_root", false)],
      [{ name: "@corbits/memory-tools", version: "^1" }],
    );
    expect(grants.length).toBeGreaterThan(0);
  });

  test("a tenant with no corbits-tools asset yields no grants, never throws", async () => {
    const assetService = await fakeRegistryAssetService([]);
    const grants = await grantsFor(assetService, [], [
      { name: "@corbits/memory-tools", version: "^1" },
    ]);
    expect(grants).toEqual([]);
  });

  test("no pins yields no grants", async () => {
    const assetService = await fakeRegistryAssetService([
      await packToolPackageTarball(MEMORY_DIR),
    ]);
    expect(await grantsFor(assetService, [assetRow("asset_1", true)], [])).toEqual(
      [],
    );
  });
});
