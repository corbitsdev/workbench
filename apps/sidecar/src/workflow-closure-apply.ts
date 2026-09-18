// The durable deploy counterpart to the airlocked install-time probe: the
// closure is applied byte-for-byte as the hub froze it, never re-resolved
// against the registry. topLevel is emptied for applyAtomic since a
// workflow-definition package declares interchange.workflow, not
// interchange.tools, which applyAtomic's load phase would otherwise reject
// as package.entry.missing; loadWorkflowDefinitionFromClosure imports the
// workflow entry instead.

import path from "node:path";

import { getLogger } from "@intx/log";
import {
  type RegistryConfig,
  type TarballFetcher,
  applyAtomic,
  createTarballCache,
  createToolLoader,
  storeEntryDir,
} from "@intx/tool-packaging";
import type { ToolPackageManifest } from "@intx/types/tool-packages";
import { getToolPackageSourceContentIdentity } from "@intx/types/tool-packages";
import type { WorkflowDefinitionSource } from "@intx/types/workflow-sources";
import { loadWorkflowDefinitionFromClosure } from "@intx/workflow-host";
import type { WorkflowDefinition } from "@intx/workflow/definition";

const logger = getLogger(["sidecar", "workflow-closure-apply"]);

export interface ApplyFrozenWorkflowClosureArgs {
  /** Names the registry the workflow definition package is published to. */
  readonly source: WorkflowDefinitionSource;
  /** Concrete versions and integrity SRIs; applied byte-for-byte, never re-resolved. */
  readonly closure: ToolPackageManifest;
  /** Durable per-deployment directory the closure is staged under. */
  readonly instanceDir: string;
  /** Content-addressable tarball cache root shared across applies. */
  readonly cacheRoot: string;
  /** Byte cap for the tarball cache. */
  readonly cacheMaxBytes: number;
  /** Byte cap for a single HTTP-registry tarball fetch. */
  readonly registryMaxTarballBytes: number;
  /** Registry identifier -> URL + credentials the loader resolves entries against. */
  readonly registries: ReadonlyMap<string, RegistryConfig>;
  /** Defaults to <instanceDir>/workspace; a registry-sourced closure carries no asset entries. */
  readonly assetRoot?: string;
  /** assetId -> mount path for tarball asset entries; empty by default. */
  readonly assetMounts?: ReadonlyMap<string, string>;
  /** assetId -> indexed git directory for source-format entries; empty by default. */
  readonly gitDirs?: ReadonlyMap<string, string>;
  /** Test seam; production fetches from the configured registry. */
  readonly fetchTarball?: TarballFetcher;
  /** Test seam; production imports the materialized entry natively. */
  readonly importModule?: (importUrl: string) => Promise<unknown>;
}

export interface AppliedWorkflowClosure {
  /** The validated definition the pinned code evaluated to. */
  readonly definition: WorkflowDefinition;
  /** Directory of the materialized workflow package within the closure. */
  readonly packageDir: string;
  /** The staged, never-renamed deploy directory the closure was laid out under. */
  readonly deployDir: string;
}

/** The frozen entries are applied verbatim; no registry re-resolution happens at apply time. */
export async function applyFrozenWorkflowClosure(
  args: ApplyFrozenWorkflowClosureArgs,
): Promise<AppliedWorkflowClosure> {
  if (args.closure.topLevel.length !== 1) {
    throw new Error(
      `sidecar workflow-closure apply: the frozen closure must carry exactly one top-level pin (the workflow definition package), got ${String(args.closure.topLevel.length)}`,
    );
  }
  const workflowPin = args.closure.topLevel[0];
  if (workflowPin === undefined) {
    throw new Error(
      "sidecar workflow-closure apply: the frozen closure's single top-level pin is undefined",
    );
  }

  // The never default makes a future source kind a compile error, not a silent fallthrough.
  switch (args.source.kind) {
    case "registry":
      if (!args.registries.has(args.source.registry)) {
        throw new Error(
          `sidecar workflow-closure apply: source registry ${JSON.stringify(args.source.registry)} is not in the sidecar registry config`,
        );
      }
      break;
    case "asset":
      break;
    default: {
      const _exhaustive: never = args.source;
      throw new Error(
        `sidecar workflow-closure apply: unhandled workflow source kind ${String(_exhaustive)}`,
      );
    }
  }

  const cache = createTarballCache({
    rootDir: args.cacheRoot,
    maxBytes: args.cacheMaxBytes,
  });
  const loader = createToolLoader({
    cache,
    registries: args.registries,
    host: { os: process.platform, cpu: process.arch },
    maxRegistryTarballBytes: args.registryMaxTarballBytes,
    ...(args.fetchTarball !== undefined ? { fetchTarball: args.fetchTarball } : {}),
  });

  const layoutManifest: ToolPackageManifest = {
    schemaVersion: args.closure.schemaVersion,
    topLevel: [],
    entries: args.closure.entries,
  };

  const result = await applyAtomic({
    manifest: layoutManifest,
    loader,
    instanceDir: args.instanceDir,
    assetRoot: args.assetRoot ?? path.join(args.instanceDir, "workspace"),
    assetMounts: args.assetMounts ?? new Map(),
    gitDirs: args.gitDirs ?? new Map(),
    attemptId: crypto.randomUUID(),
    // No prior deploy under instanceDir to retain, so this disables the retention window.
    previousDeployId: "none",
    newDeployId: crypto.randomUUID(),
  });
  if (result.status === "failed") {
    throw new Error(
      `sidecar workflow-closure apply: materializing the frozen closure for ${workflowPin.name}@${workflowPin.version} failed (${result.category}): ${result.message}`,
    );
  }

  const packageDir = storeEntryDir(
    path.join(result.deployDir, "store"),
    workflowPin.name,
    workflowPin.version,
  );

  // The package's own integrity is the cache-bust token: a re-apply of
  // changed bytes under the same name@version reimports rather than
  // resolving to the prior module-cache instance.
  const workflowEntry = args.closure.entries.find(
    (entry) => entry.name === workflowPin.name && entry.version === workflowPin.version,
  );

  const definition = await loadWorkflowDefinitionFromClosure({
    packageDir,
    ...(workflowEntry !== undefined
      ? {
          importCacheKey: getToolPackageSourceContentIdentity(workflowEntry.source),
        }
      : {}),
    ...(args.importModule !== undefined ? { importModule: args.importModule } : {}),
  });

  logger.debug`applied frozen workflow closure ${workflowPin.name}@${workflowPin.version}: loaded definition ${definition.id}`;
  return { definition, packageDir, deployDir: result.deployDir };
}
