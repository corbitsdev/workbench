import { describe, expect, test } from "bun:test";
import type { listAssetsForTenant } from "@intx/db";
import type { createClosureResolver } from "@intx/tool-packaging";
import { createToolManifestRouter } from "./tool-manifest";

// The route lists tenant package-registry assets (`listAssetsForTenant`) and
// resolves the closure (`createClosureResolver`). Both are injected so the
// test exercises the route's gating, mount derivation, and tarball serving
// without standing up a real asset repo or resolver — and without leaking a
// process-global module mock into the rest of the hub suite.
const fakeListAssets = (async () => [
  { id: "asset-builtins", name: "workspace-builtins", tenantId: "t1" },
]) as unknown as typeof listAssetsForTenant;

const fakeResolver = (() => ({
  resolveClosure: async () => ({
    schemaVersion: "1" as const,
    topLevel: [{ name: "@workbench/tools-granola", version: "^0.1.0" }],
    entries: [
      {
        name: "@workbench/tools-granola",
        version: "0.1.0",
        integrity: "sha512-x",
        source: {
          kind: "asset" as const,
          assetId: "asset-builtins",
          path: "tarballs/granola.tgz",
        },
      },
    ],
  }),
})) as unknown as typeof createClosureResolver;

function makeRouter(opts: {
  toolPackages: unknown;
  agentFound?: boolean;
  blobBytes?: number;
}) {
  const db = {
    query: {
      agent: {
        findFirst: async () =>
          opts.agentFound === false
            ? undefined
            : { id: "a1", toolPackages: opts.toolPackages },
      },
    },
  } as unknown as Parameters<typeof createToolManifestRouter>[0];
  const assetService = {
    readAssetBlob: async () =>
      opts.blobBytes === undefined
        ? new TextEncoder().encode("TARBALL-BYTES")
        : new Uint8Array(opts.blobBytes),
    listAssetBlobs: async () => [],
  } as unknown as Parameters<typeof createToolManifestRouter>[2];
  return createToolManifestRouter(
    db,
    "sidecar-token",
    assetService,
    fakeListAssets,
    fakeResolver,
  );
}

async function post(
  router: ReturnType<typeof createToolManifestRouter>,
  body: unknown,
  token = "sidecar-token",
): Promise<Response> {
  return router.request("/tools/manifest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

const req = { tenantId: "t1", agentId: "a1" };

describe("POST /tools/manifest", () => {
  test("rejects an unauthorized caller", async () => {
    const res = await post(
      makeRouter({
        toolPackages: [{ name: "@workbench/tools-granola", version: "^0.1.0" }],
      }),
      req,
      "wrong",
    );
    expect(res.status).toBe(401);
  });

  test("returns 404 when the agent row is missing", async () => {
    const res = await post(
      makeRouter({ toolPackages: [], agentFound: false }),
      req,
    );
    expect(res.status).toBe(404);
  });

  test("returns an empty manifest for an agent with no pins", async () => {
    const res = await post(makeRouter({ toolPackages: [] }), req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manifest: { entries: unknown[] };
      tarballs: unknown[];
    };
    expect(body.manifest.entries).toEqual([]);
    expect(body.tarballs).toEqual([]);
  });

  test("resolves the manifest and serves each asset tarball with its mount", async () => {
    const res = await post(
      makeRouter({
        toolPackages: [{ name: "@workbench/tools-granola", version: "^0.1.0" }],
      }),
      req,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manifest: { entries: Array<{ name: string }> };
      tarballs: Array<{
        assetId: string;
        mount: string;
        path: string;
        bytesBase64: string;
      }>;
    };
    expect(body.manifest.entries.map((e) => e.name)).toEqual([
      "@workbench/tools-granola",
    ]);
    expect(body.tarballs).toHaveLength(1);
    const tarball = body.tarballs[0]!;
    expect(tarball.assetId).toBe("asset-builtins");
    expect(tarball.mount).toBe("package-registries/workspace-builtins/");
    expect(tarball.path).toBe("tarballs/granola.tgz");
    expect(Buffer.from(tarball.bytesBase64, "base64").toString()).toBe(
      "TARBALL-BYTES",
    );
  });

  test("returns 413 when a tarball exceeds the per-tarball byte cap", async () => {
    const res = await post(
      makeRouter({
        toolPackages: [{ name: "@workbench/tools-granola", version: "^0.1.0" }],
        blobBytes: 64 * 1024 * 1024 + 1,
      }),
      req,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("per-tarball");
  });
});
