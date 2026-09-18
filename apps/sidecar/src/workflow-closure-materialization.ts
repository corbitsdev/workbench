// Materializes a probe's frozen closure on the sidecar host (I/O only, no
// author-code eval) before the airlocked child evaluates it. Lives in
// apps/sidecar so @intx/workflow-host stays free of @intx/tool-packaging.
// loadManifest runs with an emptied topLevel so it lays out every entry
// without importing (evaluating) any of them.

import { promises as fs } from "node:fs";
import path from "node:path";

import { type } from "arktype";
import { getLogger } from "@intx/log";
import {
  type RegistryConfig,
  type TarballFetcher,
  createTarballCache,
  createToolLoader,
  storeEntryDir,
} from "@intx/tool-packaging";
import { PackageJSON } from "@intx/types/package-json";
import type { WorkflowProbeRequestFrame } from "@intx/types/sidecar";
import type { ToolPackageManifest } from "@intx/types/tool-packages";

import { materializeWorkflowAssets } from "./source-asset-delivery";
import { resolveHostPlatform } from "./sidecar-materialization-config";
import type {
  MaterializedWorkflowClosure,
  MaterializeWorkflowClosure,
} from "./workflow-probe-handler";

const logger = getLogger(["sidecar", "workflow-closure-materialization"]);

export interface WorkflowClosureMaterializerConfig {
  /** Content-addressable tarball cache root shared across materializations. */
  readonly cacheRoot: string;
  /** Byte cap for the tarball cache. */
  readonly cacheMaxBytes: number;
  /** Byte cap for a single HTTP-registry tarball fetch. */
  readonly registryMaxTarballBytes: number;
  /** Enforced against the base64 wire length, before decoding, so an oversized frame fails loud. */
  readonly maxAssetPayloadBytes: number;
  /** Registry identifier -> URL + credentials the loader resolves entries against. */
  readonly registries: ReadonlyMap<string, RegistryConfig>;
  /**
   * Root directory under which each probe's ephemeral closure scratch dir
   * is created (one per probe, removed by the returned `cleanup`).
   */
  readonly scratchRoot: string;
  /**
   * Test seam for tarball fetching, forwarded to `createToolLoader`.
   * Production omits it and the loader fetches from the configured registry.
   */
  readonly fetchTarball?: TarballFetcher;
}

/** Lays out a probe frame's frozen closure under a fresh scratch dir removed by the returned cleanup. */
export function createWorkflowClosureMaterializer(
  config: WorkflowClosureMaterializerConfig,
): MaterializeWorkflowClosure {
  const host = resolveHostPlatform();

  return async function materialize(
    frame: WorkflowProbeRequestFrame,
  ): Promise<MaterializedWorkflowClosure> {
    // Fail loud rather than silently picking [0]: a 0- or >1-pin closure is
    // an incoherent request this boundary owns rejecting.
    const topLevel = frame.closure.topLevel;
    if (topLevel.length !== 1) {
      throw new Error(
        `workflow-probe closure materialization: the frozen closure must pin exactly one top-level package (the workflow definition package), got ${String(topLevel.length)}`,
      );
    }
    const workflowPin = topLevel[0];
    if (workflowPin === undefined) {
      throw new Error(
        "workflow-probe closure materialization: the frozen closure's single top-level pin is undefined",
      );
    }

    // The never default makes a future source kind a compile error, not a silent fallthrough.
    switch (frame.source.kind) {
      case "registry":
        if (!config.registries.has(frame.source.registry)) {
          throw new Error(
            `workflow-probe closure materialization: source registry ${JSON.stringify(frame.source.registry)} is not in the sidecar registry config`,
          );
        }
        break;
      case "asset":
        break;
      default: {
        const _exhaustive: never = frame.source;
        throw new Error(
          `workflow-probe closure materialization: unhandled workflow source kind ${String(_exhaustive)}`,
        );
      }
    }

    const scratchDir = path.join(config.scratchRoot, crypto.randomUUID());
    await fs.mkdir(scratchDir, { recursive: true });
    const cleanup = async (): Promise<void> => {
      await fs.rm(scratchDir, { recursive: true, force: true });
    };

    try {
      const cache = createTarballCache({
        rootDir: config.cacheRoot,
        maxBytes: config.cacheMaxBytes,
      });
      const loader = createToolLoader({
        cache,
        registries: config.registries,
        host,
        maxRegistryTarballBytes: config.registryMaxTarballBytes,
        ...(config.fetchTarball !== undefined ? { fetchTarball: config.fetchTarball } : {}),
      });

      // Registry-sourced closures deliver no assets; both maps stay empty
      // and the loader fetches over HTTP instead.
      const assetRoot = path.join(scratchDir, "workspace");
      const gitDirRoot = path.join(scratchDir, "gitdirs");
      const { assetMounts, gitDirs } = await materializeWorkflowAssets({
        assets: frame.assets ?? [],
        closure: frame.closure,
        assetRoot,
        gitDirRoot,
        maxAssetPayloadBytes: config.maxAssetPayloadBytes,
      });

      // The asset the definition is sourced from must be among the delivered
      // assets; surface a missing delivery here, not as a downstream failure.
      if (frame.source.kind === "asset") {
        const delivered =
          frame.source.package.format === "source"
            ? gitDirs.has(frame.source.assetId)
            : assetMounts.has(frame.source.assetId);
        if (!delivered) {
          throw new Error(
            `workflow-probe closure materialization: asset source ${JSON.stringify(frame.source.assetId)} was not among the delivered assets`,
          );
        }
      }

      // topLevel emptied so the loader's phase-3 import loop runs nothing on
      // the host; the airlocked child owns the single import.
      const layoutManifest: ToolPackageManifest = {
        schemaVersion: frame.closure.schemaVersion,
        topLevel: [],
        entries: frame.closure.entries,
      };
      await loader.loadManifest({
        manifest: layoutManifest,
        instanceScratchDir: scratchDir,
        assetRoot,
        assetMounts,
        gitDirs,
      });

      const storeDir = path.join(scratchDir, "store");
      const packageDir = storeEntryDir(storeDir, workflowPin.name, workflowPin.version);

      await assertFrameEntryMatchesPackage(packageDir, frame.entry);

      logger.debug`materialized workflow-probe closure for ${workflowPin.name}@${workflowPin.version} at ${packageDir}`;
      return { packageDir, cleanup };
    } catch (err) {
      // The executor never sees a cleanup to call before a handle is returned.
      await cleanup();
      throw err;
    }
  };
}

/** The child loader ignores frame.entry; comparing it host-side surfaces a tampered request before the child spawns. */
async function assertFrameEntryMatchesPackage(
  packageDir: string,
  frameEntry: string,
): Promise<void> {
  const pkgJsonPath = path.join(packageDir, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(pkgJsonPath, "utf8");
  } catch (cause) {
    throw new Error(
      `workflow-probe closure materialization: cannot read package.json at ${packageDir} to cross-check the frame entry`,
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `workflow-probe closure materialization: malformed package.json at ${packageDir}`,
      { cause },
    );
  }
  const pkg = PackageJSON(parsed);
  if (pkg instanceof type.errors) {
    throw new Error(
      `workflow-probe closure materialization: package.json at ${packageDir} failed validation: ${pkg.summary}`,
    );
  }
  const declaredEntry = pkg.interchange?.workflow;
  if (declaredEntry === undefined) {
    throw new Error(
      `workflow-probe closure materialization: workflow package at ${packageDir} declares no "interchange.workflow" entry`,
    );
  }
  if (declaredEntry !== frameEntry) {
    throw new Error(
      `workflow-probe closure materialization: probe frame entry ${JSON.stringify(frameEntry)} does not match the materialized package's interchange.workflow ${JSON.stringify(declaredEntry)}`,
    );
  }
}
