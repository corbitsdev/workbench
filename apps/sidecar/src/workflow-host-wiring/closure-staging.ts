// Staging for a deployment's frozen workflow-definition closure: the
// durable per-deployment stores its source assets are checked out into,
// and the apply that lays the closure out and evaluates the pinned code
// to a `WorkflowDefinition`. Both the deploy path and the boot-time
// restore path route through here, so the two resolve identical mounts
// from the pin alone -- restore has only the pin, never a re-delivery.

import { rm, stat } from "node:fs/promises";
import { join as pathJoin } from "node:path";

import { workflowSourceAssetMountPath } from "@intx/hub-sessions";
import type { SourceRefPin } from "@intx/types/sidecar";

import {
  applyFrozenWorkflowClosure,
  type AppliedWorkflowClosure,
} from "../workflow-closure-apply";
import { sourceAssetGitDir } from "../source-asset-delivery";
import { parseToolRegistries } from "../tool-materialization";

/**
 * The durable per-deployment store the sidecar checks a deployment's source
 * assets out into. A SIBLING of the closure instance dir, not a child:
 * `materializeDeploymentClosure` reclaims the closure dir on every apply and
 * restore, but never this store, so the checked-out assets survive a restart
 * and re-materialization needs no re-delivery. The store is reclaimed on
 * redeploy (at the deploy call site) and on undeploy.
 */
export function deploymentSourceAssetRoot(
  dataDir: string,
  deploymentId: string,
): string {
  return pathJoin(dataDir, "workflow-definition-sources", deploymentId);
}

/**
 * The durable indexed-`.git` store root a pinned deployment's source-format
 * asset entries are checked out from. Sibling of the plain-file source store;
 * both survive restart so re-materialization needs no re-delivery.
 */
export function deploymentSourceGitRoot(
  dataDir: string,
  deploymentId: string,
): string {
  return pathJoin(dataDir, "workflow-definition-source-gits", deploymentId);
}

/**
 * The per-deployment directory a deployment's closure is laid out under.
 * Deterministic per deployment id, so a redeploy or a boot restore reuses it.
 */
export function deploymentClosureInstanceDir(
  dataDir: string,
  deploymentId: string,
): string {
  return pathJoin(dataDir, "workflow-definition-closures", deploymentId);
}

function deriveSourceAssetMounts(pin: SourceRefPin): Map<string, string> {
  const mounts = new Map<string, string>();
  for (const entry of pin.closure.entries) {
    if (
      entry.source.kind === "asset" &&
      entry.source.package.format === "tarball"
    ) {
      mounts.set(
        entry.source.assetId,
        workflowSourceAssetMountPath(entry.source.assetId),
      );
    }
  }
  return mounts;
}

function deriveSourceGitDirs(
  pin: SourceRefPin,
  gitRoot: string,
): Map<string, string> {
  const gitDirs = new Map<string, string>();
  for (const entry of pin.closure.entries) {
    if (
      entry.source.kind === "asset" &&
      entry.source.package.format === "source"
    ) {
      gitDirs.set(
        entry.source.assetId,
        sourceAssetGitDir(gitRoot, entry.source.assetId),
      );
    }
  }
  return gitDirs;
}

async function isExistingDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * Resolve the durable source-asset store root and the `assetId -> mountPath` /
 * `assetId -> gitDir` maps a pinned deployment materializes its
 * `kind: "asset"` closure entries from, asserting every referenced asset is
 * present on disk. A cheap early gate for a missing checkout; the loader still
 * SRI-verifies each tarball's bytes at materialization. A missing mount is a
 * broken deployment the hub must re-drive, so it fails loud rather than
 * materializing against an absent store.
 */
export async function resolveDeploymentAssetMounts(
  dataDir: string,
  deploymentId: string,
  pin: SourceRefPin,
): Promise<{
  assetRoot: string;
  assetMounts: ReadonlyMap<string, string>;
  gitDirs: ReadonlyMap<string, string>;
}> {
  const assetRoot = deploymentSourceAssetRoot(dataDir, deploymentId);
  const assetMounts = deriveSourceAssetMounts(pin);
  for (const [assetId, mountPath] of assetMounts) {
    const mountDir = pathJoin(assetRoot, mountPath);
    if (!(await isExistingDir(mountDir))) {
      throw new Error(
        `resolveDeploymentAssetMounts: source asset ${JSON.stringify(assetId)} for deployment ${deploymentId} is not present in the durable store at ${mountDir}; the deployment must be re-driven from the hub`,
      );
    }
  }
  const gitRoot = deploymentSourceGitRoot(dataDir, deploymentId);
  const gitDirs = deriveSourceGitDirs(pin, gitRoot);
  for (const [assetId, gitDir] of gitDirs) {
    if (!(await isExistingDir(gitDir))) {
      throw new Error(
        `resolveDeploymentAssetMounts: source asset ${JSON.stringify(assetId)} for deployment ${deploymentId} has no indexed git store at ${gitDir}; the deployment must be re-driven from the hub`,
      );
    }
  }
  return { assetRoot, assetMounts, gitDirs };
}

/**
 * Read a substrate-config byte cap (`SIDECAR_CACHE_MAX_BYTES` /
 * `SIDECAR_REGISTRY_MAX_TARBALL_BYTES`) from the multi-step substrate env and
 * parse it to a positive finite number. The boot edge resolves these once and
 * threads them through the substrate env; the closure apply needs them to size
 * the tarball cache and the per-fetch cap. A missing or non-numeric value is a
 * boot-edge wiring bug, so it fails loud rather than defaulting.
 */
export function requireSubstrateByteCap(
  env: Record<string, string>,
  key: string,
): number {
  const raw = env[key];
  if (raw === undefined) {
    throw new Error(
      `sidecar deploy router: ${key} must be present in the multi-step substrate env to materialize a frozen workflow closure`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `sidecar deploy router: ${key} must be a positive finite number, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * Materialize a deployment's frozen closure to its per-deployment instance dir
 * and evaluate the pinned code. The instance dir is force-reclaimed first: the
 * id is deterministic per address, so a redeploy or a boot restore reuses the
 * same dir and a prior soft-failed deploy can leave it half-materialized. Safe
 * only because no live reader holds the dir when this runs -- a precondition
 * each caller establishes.
 */
export async function materializeDeploymentClosure(args: {
  dataDir: string;
  deploymentId: string;
  pin: SourceRefPin;
  substrateEnv: Record<string, string>;
}): Promise<AppliedWorkflowClosure> {
  const instanceDir = deploymentClosureInstanceDir(
    args.dataDir,
    args.deploymentId,
  );
  await rm(instanceDir, { recursive: true, force: true });

  const { assetRoot, assetMounts, gitDirs } =
    await resolveDeploymentAssetMounts(
      args.dataDir,
      args.deploymentId,
      args.pin,
    );

  return applyFrozenWorkflowClosure({
    source: args.pin.source,
    closure: args.pin.closure,
    instanceDir,
    cacheRoot: pathJoin(args.dataDir, "workflow-definition-closure-cache"),
    cacheMaxBytes: requireSubstrateByteCap(
      args.substrateEnv,
      "SIDECAR_CACHE_MAX_BYTES",
    ),
    registryMaxTarballBytes: requireSubstrateByteCap(
      args.substrateEnv,
      "SIDECAR_REGISTRY_MAX_TARBALL_BYTES",
    ),
    registries: parseToolRegistries(
      requireSubstrateEntry(args.substrateEnv, "SIDECAR_TOOL_REGISTRIES"),
    ),
    assetRoot,
    assetMounts,
    gitDirs,
  });
}

function requireSubstrateEntry(
  env: Record<string, string>,
  key: string,
): string {
  const raw = env[key];
  if (raw === undefined) {
    throw new Error(
      `sidecar deploy router: ${key} must be present in the multi-step substrate env to materialize a frozen workflow closure`,
    );
  }
  return raw;
}
