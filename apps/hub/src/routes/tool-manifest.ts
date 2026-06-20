import { Hono } from "hono";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { schema as intxSchema, listAssetsForTenant } from "@intx/db";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import {
  AssetRegistrySource,
  createClosureResolver,
  type RegistrySource,
} from "@intx/tool-packaging";
import {
  WORKSPACE_BUILTINS_REGISTRY,
  type AssetService,
} from "@intx/hub-sessions";
import { ToolPackagePin } from "@intx/types/tool-packages";
import {
  ToolManifestRequest,
  type ToolManifestTarball,
} from "@workbench/tool-credentials";

const log = getLogger(["api", "tool-manifest"]);

const ToolPackagePins = ToolPackagePin.array();

// Per-tarball and aggregate byte caps for the manifest response. Every
// referenced tarball is base64-encoded into a single JSON body, so without a
// cap a tenant with large package assets could OOM the hub. 64 MiB per tarball
// matches the sidecar loader's `DEFAULT_REGISTRY_MAX_TARBALL_BYTES`; the total
// cap bounds the assembled response.
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_TARBALL_BYTES = 256 * 1024 * 1024;

/**
 * Tool-package manifest + tarball rail for workflow STEP agents.
 *
 * A live agent's tarballs reach the sidecar via the per-agent deploy-pack
 * fan-out at `SessionService.launchSession`. A workflow step runs in the
 * shared `bin/workflow-child` and never launches a session, so it has no
 * deploy pack on disk. This route resolves the step agent's pinned tool
 * packages into a `ToolPackageManifest` against the tenant's
 * package-registry assets (the same closure resolver the session service
 * uses), then returns the resolved manifest plus the raw bytes of every
 * asset-sourced tarball the manifest references. The sidecar materializes
 * those bytes on disk and hands them to the same `@intx/tool-packaging`
 * loader the live path uses.
 *
 * Authorization mirrors the tool-credential gate: the requested agentId
 * must be a persisted `agent` row whose `toolPackages` are the pins to
 * resolve, so a sidecar-token holder cannot resolve arbitrary closures.
 */
export function createToolManifestRouter(
  db: DB["db"],
  sidecarToken: string,
  assetService: AssetService,
  // Injected for testability, mirroring `createToolCredentialsRouter`'s
  // `resolveCredential` seam. Production uses the real `@intx/db` listing and
  // `@intx/tool-packaging` resolver.
  listAssets: typeof listAssetsForTenant = listAssetsForTenant,
  createResolver: typeof createClosureResolver = createClosureResolver,
): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (c.req.header("Authorization") !== `Bearer ${sidecarToken}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  router.post("/tools/manifest", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = ToolManifestRequest(body);
    if (parsed instanceof type.errors) {
      return c.json({ error: `Invalid request: ${parsed.summary}` }, 400);
    }

    const agentRow = await db.query.agent.findFirst({
      where: eq(intxSchema.agent.id, parsed.agentId),
    });
    if (!agentRow) {
      return c.json({ error: `Agent not found: ${parsed.agentId}` }, 404);
    }
    const pins = ToolPackagePins(agentRow.toolPackages);
    if (pins instanceof type.errors) {
      return c.json(
        { error: `Agent ${parsed.agentId} has malformed tool packages` },
        422,
      );
    }
    if (pins.length === 0) {
      return c.json({
        manifest: { schemaVersion: "1", topLevel: [], entries: [] },
        tarballs: [],
      });
    }

    // Build one AssetRegistrySource per tenant-visible package-registry
    // asset, replaying the session service's `(kind, name)` shadowing:
    // the first occurrence of a name wins (child shadows parent). The
    // `assetIndex` keeps the asset name per assetId so the materialized
    // tarball's mount path can be derived without a second DB hit.
    const visibleAssets = await listAssets(
      db,
      parsed.tenantId,
      "package-registry",
    );
    const registryMap = new Map<string, RegistrySource>();
    const assetNameById = new Map<string, string>();
    for (const row of visibleAssets) {
      if (registryMap.has(row.name)) continue;
      assetNameById.set(row.id, row.name);
      registryMap.set(
        row.name,
        new AssetRegistrySource({
          name: row.name,
          assetId: row.id,
          readBlob: (path) =>
            assetService.readAssetBlob({ assetId: row.id, path }),
          listBlobs: (dir) =>
            assetService.listAssetBlobs({ assetId: row.id, dir }),
        }),
      );
    }
    if (!registryMap.has(WORKSPACE_BUILTINS_REGISTRY)) {
      return c.json(
        {
          error: `Tenant ${parsed.tenantId} has no "${WORKSPACE_BUILTINS_REGISTRY}" package-registry asset`,
        },
        422,
      );
    }

    const resolver = createResolver({
      registries: registryMap,
      defaultRegistry: WORKSPACE_BUILTINS_REGISTRY,
    });

    let manifest: Awaited<ReturnType<typeof resolver.resolveClosure>>;
    try {
      manifest = await resolver.resolveClosure(pins);
    } catch (err) {
      log.error("Tool-package closure resolution failed", {
        tenantId: parsed.tenantId,
        agentId: parsed.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Tool-package closure resolution failed" }, 500);
    }

    // Read the raw bytes of every asset-sourced tarball the manifest
    // references and pair each with its mount. The mount mirrors the
    // session service's `package-registries/<assetName>/` convention so
    // the sidecar reconstructs the same `assetMounts` map the live path
    // builds.
    const tarballs: ToolManifestTarball[] = [];
    let totalTarballBytes = 0;
    for (const entry of manifest.entries) {
      if (entry.source.kind !== "asset") continue;
      const assetName = assetNameById.get(entry.source.assetId);
      if (assetName === undefined) {
        return c.json(
          {
            error: `Manifest references asset ${entry.source.assetId} not visible to tenant`,
          },
          422,
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await assetService.readAssetBlob({
          assetId: entry.source.assetId,
          path: entry.source.path,
        });
      } catch (err) {
        log.error("Tarball read failed", {
          assetId: entry.source.assetId,
          path: entry.source.path,
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json(
          { error: `Tarball read failed for ${entry.name}@${entry.version}` },
          500,
        );
      }
      if (bytes.byteLength > MAX_TARBALL_BYTES) {
        log.error("Tarball exceeds per-tarball byte cap", {
          assetId: entry.source.assetId,
          path: entry.source.path,
          bytes: bytes.byteLength,
          cap: MAX_TARBALL_BYTES,
        });
        return c.json(
          {
            error: `Tarball ${entry.name}@${entry.version} exceeds the ${String(MAX_TARBALL_BYTES)}-byte per-tarball limit`,
          },
          413,
        );
      }
      totalTarballBytes += bytes.byteLength;
      if (totalTarballBytes > MAX_TOTAL_TARBALL_BYTES) {
        log.error("Manifest tarballs exceed total byte cap", {
          tenantId: parsed.tenantId,
          agentId: parsed.agentId,
          total: totalTarballBytes,
          cap: MAX_TOTAL_TARBALL_BYTES,
        });
        return c.json(
          {
            error: `Resolved tarballs exceed the ${String(MAX_TOTAL_TARBALL_BYTES)}-byte total limit`,
          },
          413,
        );
      }
      tarballs.push({
        assetId: entry.source.assetId,
        mount: `package-registries/${assetName}/`,
        path: entry.source.path,
        bytesBase64: Buffer.from(bytes).toString("base64"),
      });
    }

    return c.json({ manifest, tarballs });
  });

  return router;
}
