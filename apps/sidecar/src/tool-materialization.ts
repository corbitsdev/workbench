// Lives in apps/sidecar (not @intx/workflow-host) to keep that package
// host-agnostic; the child IS the sidecar binary, so its tool runtime is
// already present. Kept free of @intx/harness so the workflow-process
// child's boot graph doesn't pull in its reactor stack (enforced by a
// forbidden-import guard).
// See docs/sidecar-tool-package-durability.md for the deploy-id persist protocol.

import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import { type AnnotatedPluginFactory } from "@intx/agent";
import { getLogger } from "@intx/log";
import {
  type LoadedToolFactory,
  type LoadedToolPackage,
  applyAtomic,
  createTarballCache,
  createToolLoader,
} from "@intx/tool-packaging";
import { hasCode } from "@intx/types";
import type { ToolCredentialDeclaration } from "@intx/types/package-json";
import { ToolPackageManifest } from "@intx/types/tool-packages";

import { readRegistries, resolveHostPlatform } from "./sidecar-materialization-config";

const logger = getLogger(["sidecar", "harness-builder"]);

// Sentinel the hub treats as "no prior deploy" rather than a real id.
const NO_PRIOR_DEPLOY_ID = "none";

/**
 * Keeps package identity attached per factory because the per-bundle
 * credential assembly needs the package name and declared handles that a
 * bare factory (which carries only its bundle id) cannot supply.
 */
export interface StepToolFactory {
  readonly packageName: string;
  readonly declaredCredentials: readonly ToolCredentialDeclaration[];
  readonly factory: LoadedToolFactory;
}

interface MaterializedToolPackages {
  readonly factories: readonly StepToolFactory[];
  readonly pluginFactories: readonly AnnotatedPluginFactory[];
}

// Exported for direct unit testing of the manifest-invalid gate
// (JSON.parse failure + arktype schema failure). The workflow-process
// child reaches it through the substrate factory's per-step agent
// builder.
export async function materializeToolPackages(args: {
  rawManifestBytes: string | undefined;
  /** assetId -> workspace-relative mount path from deploy/asset-mounts.json. */
  assetMounts: ReadonlyMap<string, string>;
  storeDir: string;
  /**
   * Defaults to <storeDir>/workspace. The workflow-process child overrides
   * this to keep its asset source and apply-state root as separate directories.
   */
  assetRoot?: string;
  agentAddress: string;
  cacheRoot: string;
  cacheMaxBytes: number;
  registryMaxTarballBytes: number;
}): Promise<MaterializedToolPackages> {
  if (args.rawManifestBytes === undefined) {
    return { factories: [], pluginFactories: [] };
  }
  // Local capture: readonly-property narrowing doesn't survive the nested
  // closure boundary below.
  const rawManifestBytes = args.rawManifestBytes;

  // Shares storeDir with the factories' own workspace; the substrate trusts
  // factories not to write outside cwd rather than sandboxing this boundary.
  const instanceDir = path.join(args.storeDir, "tool-packages");
  await fs.promises.mkdir(instanceDir, { recursive: true });

  const activeIdFile = path.join(instanceDir, "active-deploy-id");
  const activeIdDirtyFile = `${activeIdFile}.dirty`;
  // See docs/sidecar-tool-package-durability.md for the dirty-marker protocol.
  let previousDeployId = NO_PRIOR_DEPLOY_ID;
  try {
    const dirtyRaw = (await fs.promises.readFile(activeIdDirtyFile, "utf-8")).trim();
    const dirtyId = parseActiveDeployId(dirtyRaw, activeIdDirtyFile);
    logger.warn`active-deploy-id dirty marker present at ${activeIdDirtyFile}; the prior apply could not durably record the committed deploy id and the boot is reconciling from ${dirtyId}`;
    previousDeployId = dirtyId;
  } catch (err) {
    if (!(hasCode(err) && err.code === "ENOENT")) {
      throw err;
    }
    try {
      const raw = (await fs.promises.readFile(activeIdFile, "utf-8")).trim();
      previousDeployId = parseActiveDeployId(raw, activeIdFile);
    } catch (innerErr) {
      if (!(hasCode(innerErr) && innerErr.code === "ENOENT")) {
        throw innerErr;
      }
    }
  }

  const attemptId = crypto.randomUUID();
  const newDeployId = crypto.randomUUID();

  // Returns rather than throws so the caller can `throw await ...`, which
  // TypeScript narrows control flow against with no dead-code suffix.
  const rejectManifestInvalid = async (reason: string): Promise<Error> => {
    const occurredAt = new Date().toISOString();
    logger.warn`tool-package apply rejected for ${args.agentAddress}: manifest.invalid — ${reason}`;
    const message = `deploy/tool-packages-manifest.json could not be loaded: ${reason}`;
    await writeRejectedApplyAudit({
      storeDir: args.storeDir,
      attemptId,
      manifestBytes: rawManifestBytes,
      failure: {
        attemptId,
        previousDeployId,
        category: "manifest.invalid",
        message,
        occurredAt,
      },
    });
    return new Error(`tool-package apply rejected (manifest.invalid): ${reason}`);
  };

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(rawManifestBytes);
  } catch (err) {
    throw await rejectManifestInvalid(
      `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const validated = ToolPackageManifest(parsedManifest);
  if (validated instanceof type.errors) {
    throw await rejectManifestInvalid(`schema validation failed: ${validated.summary}`);
  }

  const cache = createTarballCache({
    rootDir: args.cacheRoot,
    maxBytes: args.cacheMaxBytes,
  });
  const loader = createToolLoader({
    cache,
    registries: readRegistries(),
    host: resolveHostPlatform(),
    maxRegistryTarballBytes: args.registryMaxTarballBytes,
  });
  const result = await applyAtomic({
    manifest: validated,
    loader,
    instanceDir,
    assetRoot: args.assetRoot ?? path.join(args.storeDir, "workspace"),
    assetMounts: args.assetMounts,
    // Only workflow-definition closures carry git entries.
    gitDirs: new Map(),
    attemptId,
    previousDeployId,
    newDeployId,
  });
  if (result.status === "failed") {
    logger.warn`tool-package apply rejected for ${args.agentAddress}: ${result.category} — ${result.message}`;
    // A failed apply never wrote active-deploy-id, so the prior deploy is
    // trivially still live.
    await writeRejectedApplyAudit({
      storeDir: args.storeDir,
      attemptId: result.attemptId,
      // Raw bytes from disk, not the arktype-narrowed object — preserves
      // whitespace/key order/unknown fields for replay against a newer validator.
      manifestBytes: rawManifestBytes,
      failure: result,
    });
    throw new Error(`tool-package apply rejected (${result.category}): ${result.message}`);
  }

  // Persisting the id is the commit. On a degraded persist, throw so the
  // harness tears down — see docs/sidecar-tool-package-durability.md.
  const persistOutcome = await persistActiveDeployIdWithFallback(
    instanceDir,
    activeIdFile,
    result.activeDeployId,
  );
  if (persistOutcome.degraded) {
    const err = persistOutcome.error;
    const occurredAt = new Date().toISOString();
    const message = `active-deploy-id persist failed after staging deploy: ${err instanceof Error ? err.message : String(err)}`;
    logger.error`tool-package apply: ${message}; active deploy ${result.activeDeployId} is live on disk but the recorded id was not durably written`;
    await writeRejectedApplyAudit({
      storeDir: args.storeDir,
      attemptId,
      manifestBytes: rawManifestBytes,
      failure: {
        attemptId,
        previousDeployId: result.activeDeployId,
        category: "apply.previous-rotation.failed",
        message,
        occurredAt,
      },
    });
    throw new Error(`tool-package apply rejected (apply.previous-rotation.failed): ${message}`, {
      cause: err,
    });
  }
  return {
    factories: collectFactories(result.loaded),
    pluginFactories: collectPluginFactories(result.loaded),
  };
}

/**
 * Write the active deploy id to `activeIdFile` and fsync both the
 * file's own data/metadata and the parent directory entry. POSIX does
 * not guarantee a parent-directory entry is durably linked from a
 * file's own fsync alone, so the dir handle is opened and synced
 * separately. Without that, a crash between a deploy's commit and the
 * next boot could leave the staged deploy directory present while
 * active-deploy-id is not yet visible — the next apply would then read
 * previousDeployId="none" and treat the committed deploy as belonging
 * to a fresh, deploy-less instance.
 *
 * Dir-fsync is best-effort: some filesystems (FAT/exFAT, some network
 * mounts) don't support it and surface EINVAL/ENOTSUP, which shouldn't
 * force a restart when the deploy-id file's own fsync already landed.
 */
const ACTIVE_DEPLOY_ID_VERSION = "v1";
const ACTIVE_DEPLOY_ID_PREFIX = `${ACTIVE_DEPLOY_ID_VERSION}:`;

// Exported for unit testing of the version-prefix gate.
export function parseActiveDeployId(raw: string, sourcePath: string): string {
  if (raw.length === 0) {
    throw new Error(
      `active-deploy-id file ${sourcePath} is empty; expected ${ACTIVE_DEPLOY_ID_PREFIX}<deploy-id>`,
    );
  }
  // Accepts pre-versioning unprefixed files so upgrade needs no operator
  // rewrite; delete this branch once every sidecar has restarted on a
  // version that writes the prefix (see docs/sidecar-tool-package-durability.md).
  if (raw.startsWith(ACTIVE_DEPLOY_ID_PREFIX)) {
    const id = raw.slice(ACTIVE_DEPLOY_ID_PREFIX.length);
    if (id.length === 0) {
      throw new Error(
        `active-deploy-id file ${sourcePath} carries the ${ACTIVE_DEPLOY_ID_VERSION} prefix but no id`,
      );
    }
    return id;
  }
  if (raw.includes(":")) {
    // A leading token shaped like a version prefix that we do not
    // recognize. Surface loudly rather than treating the whole string
    // as the deploy id.
    const prefix = raw.slice(0, raw.indexOf(":") + 1);
    throw new Error(
      `active-deploy-id file ${sourcePath} carries unknown version prefix ${JSON.stringify(prefix)}; this sidecar understands ${JSON.stringify(ACTIVE_DEPLOY_ID_PREFIX)}`,
    );
  }
  return raw;
}

function formatActiveDeployId(deployId: string): string {
  return `${ACTIVE_DEPLOY_ID_PREFIX}${deployId}`;
}

async function persistActiveDeployId(
  instanceDir: string,
  activeIdFile: string,
  deployId: string,
): Promise<void> {
  const handle = await fs.promises.open(activeIdFile, "w");
  try {
    await handle.writeFile(formatActiveDeployId(deployId));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const dirHandle = await fs.promises.open(instanceDir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (err) {
    logger.warn`parent-dir fsync failed for ${instanceDir} after deploy-id persist; deploy-id durability is degraded but the committed deploy is staged on disk — ${err instanceof Error ? err.message : String(err)}`;
  }
  await clearDirtyMarker(activeIdFile, "successful persist");
}

/**
 * Best-effort: a leftover marker would otherwise shadow the recorded id on
 * the next boot, since the boot reader prefers it when present.
 */
export async function clearDirtyMarker(activeIdFile: string, reason: string): Promise<void> {
  try {
    await fs.promises.unlink(`${activeIdFile}.dirty`);
  } catch (err) {
    if (!(hasCode(err) && err.code === "ENOENT")) {
      logger.warn`failed to clear active-deploy-id dirty marker after ${reason}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// See docs/sidecar-tool-package-durability.md for the degradation ladder.
export async function persistActiveDeployIdWithFallback(
  instanceDir: string,
  activeIdFile: string,
  deployId: string,
): Promise<{ readonly degraded: boolean; readonly error?: unknown }> {
  try {
    await persistActiveDeployId(instanceDir, activeIdFile, deployId);
    return { degraded: false };
  } catch (primary) {
    logger.warn`active-deploy-id primary persist failed for ${activeIdFile}: ${primary instanceof Error ? primary.message : String(primary)}; attempting degraded write`;
    try {
      await fs.promises.writeFile(activeIdFile, formatActiveDeployId(deployId));
      logger.warn`active-deploy-id degraded write succeeded (no fsync); next boot reads the recorded id from disk but a crash before flush may reveal the prior id`;
      await clearDirtyMarker(activeIdFile, "degraded persist");
      return { degraded: true, error: primary };
    } catch (fallback) {
      logger.error`active-deploy-id degraded write also failed for ${activeIdFile}: ${fallback instanceof Error ? fallback.message : String(fallback)}; writing dirty marker so the next boot can reconcile`;
      try {
        const dirtyPath = `${activeIdFile}.dirty`;
        await fs.promises.writeFile(dirtyPath, formatActiveDeployId(deployId));
        logger.warn`active-deploy-id dirty marker written to ${dirtyPath}; next boot will prefer it over the stale recorded id`;
        return { degraded: true, error: primary };
      } catch (marker) {
        logger.error`active-deploy-id dirty marker write also failed for ${activeIdFile}.dirty: ${marker instanceof Error ? marker.message : String(marker)}; on-disk state will diverge from the recorded id for one boot cycle`;
        return { degraded: true, error: primary };
      }
    }
  }
}

// See docs/sidecar-tool-package-durability.md for the audit trail format.
async function writeRejectedApplyAudit(args: {
  storeDir: string;
  attemptId: string;
  manifestBytes: string;
  failure: {
    attemptId: string;
    previousDeployId: string;
    category: string;
    message: string;
    package?: { name: string; version: string };
    occurredAt: string;
  };
}): Promise<void> {
  const dir = path.join(args.storeDir, "audit", "rejected-applies", args.attemptId);
  await fs.promises.mkdir(dir, { recursive: true });
  // Fsynced before the caller throws so a crash right after doesn't lose
  // the evidence; fsync failures downgrade to warnings, not a second failure.
  await fsyncWriteFile(path.join(dir, "manifest.json"), args.manifestBytes);
  await fsyncWriteFile(path.join(dir, "error.json"), JSON.stringify(args.failure, null, 2));
  try {
    const dirHandle = await fs.promises.open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (err) {
    logger.warn`audit-dir fsync failed for ${dir}; rejected-apply durability is degraded but the files are written — ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function fsyncWriteFile(filePath: string, contents: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "w");
  try {
    await handle.writeFile(contents);
    try {
      await handle.sync();
    } catch (err) {
      logger.warn`fsync failed for ${filePath}; durability is degraded but the bytes are written — ${err instanceof Error ? err.message : String(err)}`;
    }
  } finally {
    await handle.close();
  }
}

function collectFactories(loaded: readonly LoadedToolPackage[]): readonly StepToolFactory[] {
  const out: StepToolFactory[] = [];
  for (const pkg of loaded) {
    for (const f of pkg.factories) {
      out.push({
        packageName: pkg.name,
        declaredCredentials: pkg.credentials,
        factory: f,
      });
    }
  }
  return out;
}

function collectPluginFactories(
  loaded: readonly LoadedToolPackage[],
): readonly AnnotatedPluginFactory[] {
  const out: AnnotatedPluginFactory[] = [];
  for (const pkg of loaded) {
    for (const p of pkg.plugins) out.push(p);
  }
  return out;
}
