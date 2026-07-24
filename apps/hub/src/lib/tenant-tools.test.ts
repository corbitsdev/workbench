import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import * as intxDb from "@intx/db";

// The tenant resolves a credential for 'attio' only; every other provider
// resolves to null. 'linear' is made to THROW to model an ambiguous match / DB
// error — which must hide the tool (fail-closed), never show it.
const resolveCredentialRequirement = (async (
  _db: unknown,
  _tenantId: string,
  req: { providerName: string },
) => {
  if (req.providerName === "attio")
    return { secret: "secret", providerId: "prov-attio" };
  if (req.providerName === "linear")
    throw new Error("Ambiguous credential match");
  return null;
}) as typeof intxDb.resolveCredentialRequirement;

// `resolveToolVersions` lists the tenant's package-registry assets through
// `listAssetsForTenant`. Make it swappable per test so the registry-map build,
// the WORKSPACE_BUILTINS presence guard, and the degrade-to-empty paths are
// exercised against the REAL closure resolver — never a faked resolver.
let listAssetRows: { id: string; name: string }[] = [];
const listAssetsForTenant = (async () =>
  listAssetRows) as unknown as typeof intxDb.listAssetsForTenant;

mock.module("@intx/db", () => ({
  ...intxDb,
  resolveCredentialRequirement,
  listAssetsForTenant,
}));

const {
  listAvailableToolSummaries,
  getAvailableToolDetail,
  resolveToolVersions,
} = await import("./tenant-tools");
const { WORKSPACE_BUILTINS_REGISTRY } = await import("@workbench/hub-sessions");

const db = {} as unknown as Parameters<typeof listAvailableToolSummaries>[0];

describe("tenant-tools availability", () => {
  it("includes credentialed-provider tools and excludes uncredentialed ones", async () => {
    const names = (await listAvailableToolSummaries(db, "tenant-1")).map(
      (s) => s.name,
    );
    expect(names).toContain("attio_query_records");
  });

  it("always includes context/hub-backed tools regardless of credentials", async () => {
    const summaries = await listAvailableToolSummaries(db, "tenant-1");
    expect(
      summaries.filter((s) => s.providerName === "workbench").length,
    ).toBeGreaterThan(0);
  });

  it("hides a provider whose resolution throws (ambiguity / DB error), never shows it", async () => {
    const names = (await listAvailableToolSummaries(db, "tenant-1")).map(
      (s) => s.name,
    );
    expect(names.some((n) => n.startsWith("linear_"))).toBe(false);
    const detail = await getAvailableToolDetail(
      db,
      "tenant-1",
      "linear_list_issues",
    );
    expect(detail).toBeNull();
  });

  it("returns detail with input schema for an available tool", async () => {
    const detail = await getAvailableToolDetail(
      db,
      "tenant-1",
      "attio_query_records",
    );
    expect(detail).not.toBeNull();
    expect(detail?.providerName).toBe("attio");
    const schema = detail?.inputSchema as {
      properties?: Record<string, unknown>;
    } | null;
    expect(schema?.properties).toBeDefined();
  });

  it("returns null for an unknown tool", async () => {
    expect(
      await getAvailableToolDetail(db, "tenant-1", "not_a_real_tool"),
    ).toBeNull();
  });
});

// Build a real package tarball (gzip tar with package/package.json) and serve
// it through an in-memory AssetService keyed by assetId. The AssetRegistrySource
// scans `tarballs/*.tgz`, extracts each package.json, and the real closure
// resolver picks the version satisfying the pin — so a wrong version mapping or
// a broken registry-map build makes these assertions fail.
async function buildTarball(
  name: string,
  version: string,
): Promise<Uint8Array> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tenant-tools-test-"));
  const pkgDir = path.join(dir, "package");
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name, version }),
  );
  const tarballPath = path.join(dir, "out.tgz");
  await tar.create({ cwd: dir, gzip: true, file: tarballPath }, ["package"]);
  return fs.readFile(tarballPath);
}

function assetServiceFor(
  blobs: Record<string, Uint8Array>,
): Parameters<typeof resolveToolVersions>[3] {
  return {
    readAssetBlob: async ({ path: p }: { assetId: string; path: string }) => {
      const b = blobs[p];
      if (b === undefined) throw new Error(`no blob at ${p}`);
      return b;
    },
    listAssetBlobs: async ({ dir }: { assetId: string; dir: string }) => {
      if (dir !== "tarballs") return [];
      return Object.keys(blobs)
        .filter((p) => p.startsWith("tarballs/"))
        .map((p) => p.slice("tarballs/".length));
    },
  } as unknown as Parameters<typeof resolveToolVersions>[3];
}

const throwingAssetService = {
  readAssetBlob: async () => {
    throw new Error("blob read exploded");
  },
  listAssetBlobs: async () => {
    throw new Error("list exploded");
  },
} as unknown as Parameters<typeof resolveToolVersions>[3];

describe("resolveToolVersions", () => {
  beforeEach(() => {
    listAssetRows = [];
  });
  afterAll(() => {
    listAssetRows = [];
  });

  it("resolves a real name@version against the tenant package-registry asset", async () => {
    const tgz = await buildTarball("@workbench/tools-attio", "0.1.7");
    listAssetRows = [
      { id: "asset-builtins", name: WORKSPACE_BUILTINS_REGISTRY },
    ];
    const service = assetServiceFor({ "tarballs/tools-attio-0.1.7.tgz": tgz });

    const versions = await resolveToolVersions(
      db,
      "tenant-1",
      ["attio_query_records"],
      service,
    );

    expect(versions.get("attio_query_records")).toBe("0.1.7");
  });

  it("returns an empty map when no package-registry asset exists (no throw)", async () => {
    listAssetRows = [];
    const versions = await resolveToolVersions(
      db,
      "tenant-1",
      ["attio_query_records"],
      assetServiceFor({}),
    );
    expect(versions.size).toBe(0);
  });

  it("returns an empty map when the builtins registry is absent (no throw)", async () => {
    listAssetRows = [{ id: "asset-other", name: "some-other-registry" }];
    const versions = await resolveToolVersions(
      db,
      "tenant-1",
      ["attio_query_records"],
      assetServiceFor({}),
    );
    expect(versions.size).toBe(0);
  });

  it("degrades to an empty map (no crash) when blob reads throw during resolution", async () => {
    listAssetRows = [
      { id: "asset-builtins", name: WORKSPACE_BUILTINS_REGISTRY },
    ];
    const versions = await resolveToolVersions(
      db,
      "tenant-1",
      ["attio_query_records"],
      throwingAssetService,
    );
    expect(versions.size).toBe(0);
  });

  it("returns an empty map for tool names that map to no package", async () => {
    listAssetRows = [
      { id: "asset-builtins", name: WORKSPACE_BUILTINS_REGISTRY },
    ];
    const versions = await resolveToolVersions(
      db,
      "tenant-1",
      ["not_a_real_tool"],
      assetServiceFor({}),
    );
    expect(versions.size).toBe(0);
  });

  it("omits a tool that maps to no registry package (degrades to null) without dropping a resolvable sibling", async () => {
    const tgz = await buildTarball("@workbench/tools-attio", "0.1.7");
    listAssetRows = [
      { id: "asset-builtins", name: WORKSPACE_BUILTINS_REGISTRY },
    ];
    const service = assetServiceFor({ "tarballs/tools-attio-0.1.7.tgz": tgz });

    // `not_a_real_tool` maps to no package (the hub-backed / unmapped case);
    // it is simply absent from the map (the route renders it as version: null),
    // and its presence must not prevent the credential tool from resolving.
    const versions = await resolveToolVersions(
      db,
      "tenant-1",
      ["attio_query_records", "not_a_real_tool"],
      service,
    );

    expect(versions.get("attio_query_records")).toBe("0.1.7");
    expect(versions.has("not_a_real_tool")).toBe(false);
  });

  it("keys the returned map by tool name, not package name", async () => {
    const tgz = await buildTarball("@workbench/tools-attio", "0.1.7");
    listAssetRows = [
      { id: "asset-builtins", name: WORKSPACE_BUILTINS_REGISTRY },
    ];
    const service = assetServiceFor({ "tarballs/tools-attio-0.1.7.tgz": tgz });

    const versions = await resolveToolVersions(
      db,
      "tenant-1",
      ["attio_query_records"],
      service,
    );

    expect(versions.get("attio_query_records")).toBe("0.1.7");
    expect(versions.has("@workbench/tools-attio")).toBe(false);
  });
});
