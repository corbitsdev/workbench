// Sidecar-side delivery of a workflow closure's source assets. A tarball
// entry checks out a plain-file mount; a source entry indexes the pack
// into a retained gitDir. One asset can be referenced both ways.

import fsp from "node:fs/promises";
import path from "node:path";

import { getLogger } from "@intx/log";
import { base64Decode } from "@intx/types";
import { applyAssetPack } from "@intx/hub-agent";
import {
  DEFAULT_PACK_MATERIALIZATION_LIMITS,
  indexPackIntoGitDir,
} from "@intx/storage-isogit/node";
import type { WorkflowSourceAssetMount } from "@intx/types/sidecar";
import type { ToolPackageManifest } from "@intx/types/tool-packages";

const logger = getLogger(["sidecar", "source-asset-delivery"]);

const SAFE_ASSET_ID = /^[a-zA-Z0-9_.-]+$/;

/**
 * Builds into a sibling temp .git and renames into place so the durable
 * store is complete-or-absent: a crash mid-materialization never leaves a
 * partial gitDir the restore dir-exists check would trust.
 */
export async function indexAssetPackIntoGitDir(args: {
  pack: Uint8Array;
  commitSha: string;
  gitDir: string;
}): Promise<void> {
  const { pack, commitSha, gitDir } = args;
  const parent = path.dirname(gitDir);
  await fsp.mkdir(parent, { recursive: true });
  const tempDir = await fsp.mkdtemp(path.join(parent, ".indexing-"));

  const cleanupTemp = async (): Promise<void> => {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch((rmErr) => {
      const rmMsg = rmErr instanceof Error ? rmErr.message : String(rmErr);
      logger.warn`source-asset temp gitdir cleanup failed at ${tempDir}: ${rmMsg}`;
    });
  };

  try {
    await indexPackIntoGitDir(tempDir, pack, commitSha, DEFAULT_PACK_MATERIALIZATION_LIMITS);
  } catch (err) {
    await cleanupTemp();
    throw err;
  }

  try {
    await fsp.rename(tempDir, gitDir);
  } catch (err) {
    // Only "destination exists" means a torn prior attempt to supersede;
    // any other rename error must not destroy a possibly-good prior store.
    if (!isDestinationExistsError(err)) {
      await cleanupTemp();
      throw err;
    }
    await fsp.rm(gitDir, { recursive: true, force: true });
    try {
      await fsp.rename(tempDir, gitDir);
    } catch (retryErr) {
      await cleanupTemp();
      throw retryErr;
    }
  }
}

/** Whether `err` is a rename failure caused by a non-empty destination. */
function isDestinationExistsError(err: unknown): boolean {
  if (err === null || typeof err !== "object" || !("code" in err)) return false;
  const code = String(err.code);
  return code === "ENOTEMPTY" || code === "EEXIST" || code === "EISDIR";
}

/**
 * The materialization format(s) each asset id is referenced with in `closure`.
 * An asset with any tarball entry needs a plain-file checkout; an asset with
 * any source entry needs a gitDir.
 */
export function assetReferenceFormats(
  closure: ToolPackageManifest,
): Map<string, { tarball: boolean; source: boolean }> {
  const byAsset = new Map<string, { tarball: boolean; source: boolean }>();
  for (const entry of closure.entries) {
    if (entry.source.kind !== "asset") continue;
    const existing = byAsset.get(entry.source.assetId) ?? {
      tarball: false,
      source: false,
    };
    if (entry.source.package.format === "tarball") existing.tarball = true;
    else existing.source = true;
    byAsset.set(entry.source.assetId, existing);
  }
  return byAsset;
}

/** The absolute gitDir a source asset's objects are indexed into. */
export function sourceAssetGitDir(gitDirRoot: string, assetId: string): string {
  // SAFE_ASSET_ID permits "." as a character, so an all-dots id must be
  // rejected separately or it escapes/aliases the per-asset dir.
  if (!SAFE_ASSET_ID.test(assetId) || /^\.+$/.test(assetId)) {
    throw new Error(`source-asset delivery: unsafe assetId ${JSON.stringify(assetId)}`);
  }
  return path.join(gitDirRoot, assetId);
}

/** Shared by probe and deploy so the two paths cannot drift; exceeding it signals moving to a streamed transfer. */
export const MAX_INLINE_ASSET_PAYLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Materialize a workflow closure's delivered source assets: for each asset,
 * check out plain tarball files under `assetRoot` (if the closure has tarball
 * entries for it) and/or index the pack into a gitDir under `gitDirRoot` (if it
 * has source entries). Returns both maps for the loader.
 */
export async function materializeWorkflowAssets(args: {
  assets: readonly WorkflowSourceAssetMount[];
  closure: ToolPackageManifest;
  assetRoot: string;
  gitDirRoot: string;
  maxAssetPayloadBytes: number;
}): Promise<{
  assetMounts: ReadonlyMap<string, string>;
  gitDirs: ReadonlyMap<string, string>;
}> {
  const formats = assetReferenceFormats(args.closure);
  const assetMounts = new Map<string, string>();
  const gitDirs = new Map<string, string>();
  const seen = new Set<string>();
  let totalPayloadBytes = 0;
  for (const asset of args.assets) {
    totalPayloadBytes += asset.pack.length;
    if (totalPayloadBytes > args.maxAssetPayloadBytes) {
      throw new Error(
        `workflow source-asset materialization: inline asset payload exceeds the ${String(args.maxAssetPayloadBytes)}-byte cap`,
      );
    }
    if (seen.has(asset.assetId)) {
      throw new Error(
        `workflow source-asset materialization: asset ${JSON.stringify(asset.assetId)} is delivered more than once`,
      );
    }
    seen.add(asset.assetId);
    // An asset with no closure entry is a hub/frame inconsistency; fail loud.
    const refs = formats.get(asset.assetId);
    if (refs === undefined) {
      throw new Error(
        `workflow source-asset materialization: asset ${JSON.stringify(asset.assetId)} is delivered but referenced by no closure entry`,
      );
    }
    const pack = base64Decode(asset.pack);
    if (refs.tarball) {
      await applyAssetPack({
        workspaceRoot: args.assetRoot,
        mountPath: asset.mountPath,
        pack,
        ref: asset.ref,
        commitSha: asset.commitSha,
      });
      assetMounts.set(asset.assetId, asset.mountPath);
    }
    if (refs.source) {
      const gitDir = sourceAssetGitDir(args.gitDirRoot, asset.assetId);
      await indexAssetPackIntoGitDir({
        pack,
        commitSha: asset.commitSha,
        gitDir,
      });
      gitDirs.set(asset.assetId, gitDir);
    }
  }
  return { assetMounts, gitDirs };
}
