import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import {
  AssetServiceError,
  type AssetService,
  type RepoStore,
} from "@intx/hub-sessions";
import type { HubDb } from "../db";
import {
  EmbeddedToolPackageManifestSchema,
  classifyToolPackageDrift,
  embeddedToolPackagesDir,
  type EmbeddedToolPackageRow,
} from "../lib/tool-packages-embedded";
import { putPackageRegistryTarball } from "../lib/package-registry-tarball-upload";

const log = getLogger(["services", "tool-packages-bootstrap"]);

export interface ToolPackagesBootstrapDeps {
  db: HubDb;
  repoStore: RepoStore;
  assetService: AssetService;
  rootTenantId: string;
  enabled: boolean;
  registryName: string;
  buildSha: string | null;
  embeddedDir?: string;
}

async function loadEmbeddedManifest(
  embeddedDir: string,
): Promise<EmbeddedToolPackageRow[]> {
  const manifestPath = join(embeddedDir, "manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return [];
  }
  const parsed = EmbeddedToolPackageManifestSchema(JSON.parse(raw));
  if (parsed instanceof type.errors) {
    log.error(
      "embedded tool package manifest is invalid; skipping autopublish",
      {
        error: parsed.summary,
      },
    );
    return [];
  }
  return parsed;
}

async function findPackageRegistryAsset(
  db: HubDb,
  tenantId: string,
  registryName: string,
): Promise<{ id: string } | null> {
  const row = await db
    .select({ id: intxSchema.asset.id })
    .from(intxSchema.asset)
    .where(
      and(
        eq(intxSchema.asset.tenantId, tenantId),
        eq(intxSchema.asset.kind, "package-registry"),
        eq(intxSchema.asset.name, registryName),
      ),
    )
    .limit(1);
  return row[0] ?? null;
}

async function ensurePackageRegistryAsset(
  deps: ToolPackagesBootstrapDeps,
): Promise<string> {
  const existing = await findPackageRegistryAsset(
    deps.db,
    deps.rootTenantId,
    deps.registryName,
  );
  if (existing !== null) return existing.id;

  try {
    const created = await deps.assetService.createAsset({
      tenantId: deps.rootTenantId,
      kind: "package-registry",
      name: deps.registryName,
    });
    return created.id;
  } catch (err) {
    if (err instanceof AssetServiceError && err.reason === "duplicate_asset") {
      const raced = await findPackageRegistryAsset(
        deps.db,
        deps.rootTenantId,
        deps.registryName,
      );
      if (raced !== null) return raced.id;
    }
    throw err;
  }
}

async function readRegistryTarballBytes(
  assetService: AssetService,
  assetId: string,
  filename: string,
): Promise<Uint8Array | null> {
  const path = `tarballs/${filename}`;
  try {
    return await assetService.readAssetBlob({ assetId, path });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("has no blob at")) return null;
    throw err;
  }
}

/**
 * Sync embedded tool-package tarballs into the root tenant package-registry asset
 * (CL-3093). Idempotent per tarball via integrity comparison; fail-safe per row.
 */
export async function publishEmbeddedToolPackages(
  deps: ToolPackagesBootstrapDeps,
): Promise<void> {
  if (!deps.enabled) {
    log.info("tool registry autopublish-on-boot disabled; skipping");
    return;
  }

  const embeddedDir = deps.embeddedDir ?? embeddedToolPackagesDir();
  const rows = await loadEmbeddedManifest(embeddedDir);
  if (rows.length === 0) {
    log.info("tool registry autopublish: no embedded manifest rows; skipping");
    return;
  }

  let assetId: string;
  try {
    assetId = await ensurePackageRegistryAsset(deps);
  } catch (err) {
    log.error("tool registry autopublish: failed to ensure registry asset", {
      registryName: deps.registryName,
      tenantId: deps.rootTenantId,
      buildSha: deps.buildSha,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let uploaded = 0;
  let unchanged = 0;
  let skippedOnError = 0;

  for (const row of rows) {
    const tarballPath = join(embeddedDir, "tarballs", row.tarballFilename);
    try {
      let registryBytes: Uint8Array | null = null;
      try {
        registryBytes = await readRegistryTarballBytes(
          deps.assetService,
          assetId,
          row.tarballFilename,
        );
      } catch (err) {
        skippedOnError += 1;
        log.error(
          "tool registry autopublish: failed to read registry tarball",
          {
            name: row.name,
            filename: row.tarballFilename,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        continue;
      }

      const drift = classifyToolPackageDrift({
        embeddedIntegrity: row.integrity,
        registryBytes,
      });
      if (drift.action === "skip") {
        unchanged += 1;
        continue;
      }

      const bytes = await readFile(tarballPath);
      await putPackageRegistryTarball({
        repoStore: deps.repoStore,
        assetId,
        filename: row.tarballFilename,
        bytes: new Uint8Array(bytes),
      });
      uploaded += 1;
      log.info("tool registry autopublish: uploaded tarball", {
        name: row.name,
        version: row.version,
        filename: row.tarballFilename,
        reason: drift.reason,
        buildSha: deps.buildSha,
      });
    } catch (err) {
      skippedOnError += 1;
      log.error("tool registry autopublish: failed to sync tarball; skipping", {
        name: row.name,
        filename: row.tarballFilename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("tool registry autopublish finished", {
    registryName: deps.registryName,
    tenantId: deps.rootTenantId,
    buildSha: deps.buildSha,
    uploaded,
    unchanged,
    skippedOnError,
    total: rows.length,
  });
}
