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
  assertNoCrossAssetPackageRegistryCollisions,
  isMissingRegistryPathError,
} from "../lib/package-registry-hierarchy-guard";
import { putPackageRegistryTarball } from "../lib/package-registry-tarball-upload";
import {
  EmbeddedToolPackageManifestSchema,
  classifyToolPackageDrift,
  embeddedToolPackagesDir,
  type EmbeddedToolPackageRow,
} from "../lib/tool-packages-embedded";

const log = getLogger(["services", "tool-packages-bootstrap"]);

export class ToolRegistryAutopublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryAutopublishError";
  }
}

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
  required: boolean,
): Promise<EmbeddedToolPackageRow[]> {
  const manifestPath = join(embeddedDir, "manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    if (required) {
      throw new ToolRegistryAutopublishError(
        `embedded tool package manifest missing at ${manifestPath}`,
      );
    }
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    if (required) {
      throw new ToolRegistryAutopublishError(
        `embedded tool package manifest is not valid JSON at ${manifestPath}`,
      );
    }
    log.error("embedded tool package manifest is not valid JSON; skipping autopublish");
    return [];
  }
  const parsed = EmbeddedToolPackageManifestSchema(json);
  if (parsed instanceof type.errors) {
    if (required) {
      throw new ToolRegistryAutopublishError(
        `embedded tool package manifest is invalid: ${parsed.summary}`,
      );
    }
    log.error(
      "embedded tool package manifest is invalid; skipping autopublish",
      {
        error: parsed.summary,
      },
    );
    return [];
  }
  if (required && parsed.length === 0) {
    throw new ToolRegistryAutopublishError(
      "embedded tool package manifest has no rows",
    );
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
    if (isMissingRegistryPathError(err)) return null;
    throw err;
  }
}

/**
 * Sync embedded tool-package tarballs into the root tenant package-registry asset
 * (CL-3093). Idempotent per tarball via integrity comparison. When enabled, any
 * sync or hierarchy collision failure rejects the boot path (CL-3656).
 */
export async function publishEmbeddedToolPackages(
  deps: ToolPackagesBootstrapDeps,
): Promise<void> {
  if (!deps.enabled) {
    log.info("tool registry autopublish-on-boot disabled; skipping");
    return;
  }

  const embeddedDir = deps.embeddedDir ?? embeddedToolPackagesDir();
  const rows = await loadEmbeddedManifest(embeddedDir, true);

  const assetId = await ensurePackageRegistryAsset(deps);

  let uploaded = 0;
  let unchanged = 0;

  for (const row of rows) {
    const tarballPath = join(embeddedDir, "tarballs", row.tarballFilename);
    const registryBytes = await readRegistryTarballBytes(
      deps.assetService,
      assetId,
      row.tarballFilename,
    );

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
  }

  await assertNoCrossAssetPackageRegistryCollisions({
    db: deps.db,
    assetService: deps.assetService,
    tenantId: deps.rootTenantId,
  });

  log.info("tool registry autopublish finished", {
    registryName: deps.registryName,
    tenantId: deps.rootTenantId,
    buildSha: deps.buildSha,
    uploaded,
    unchanged,
    total: rows.length,
  });
}
