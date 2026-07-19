// Tool-package materialization + tool-credential resolution shared by the
// live-agent harness (`default-harness.ts`) and the workflow-step harness
// (`step-tool-harness.ts`). Both paths load the agent's pinned tool packages
// from the same `@intx/tool-packaging` loader, resolve the provider
// credentials those packages declare over the hub's authenticated channel,
// and merge/filter the resulting runners — so the two paths cannot drift in
// how a tool becomes available to an agent.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { type } from "arktype";
import {
  createTarballCache,
  createToolLoader,
  type LoadedToolPackage,
} from "@intx/tool-packaging";
import { ToolPackageManifest } from "@intx/types/tool-packages";
import {
  ToolCredentialsResponse,
  toolCredentialEnvKey,
} from "@workbench/tool-credentials";
import { getLogger } from "@intx/log";
import type { ToolDefinition, ToolRunner } from "@intx/types/runtime";

const logger = getLogger(["sidecar", "agent-tools"]);

export type DefinedRunner = ToolRunner & { definitions: ToolDefinition[] };

/**
 * Build an `importModule` for `createToolLoader` that memoizes dynamic
 * imports across agents within a single sidecar process, keyed on the
 * `integrity` query param of the import URL.
 *
 * The M3 tool-package substrate materializes each agent's pinned packages
 * into a PER-AGENT scratch dir and imports `file://<per-agent path>?integrity=
 * <sri>`. Because the path differs per agent, Node/Bun's ESM module cache
 * cannot dedup: the full JS module graph of every tool package is loaded into
 * the V8 heap once PER AGENT. At 100 agents that is 100 private copies of the
 * same tool code — the 4GB OOM.
 *
 * Keying on `integrity` is sound: same integrity means identical bytes, so the
 * imported module is interchangeable across agents regardless of the path it
 * was materialized at. The loader appends `integrity` precisely so distinct
 * bytes (a republished tarball under the same name@version) get a distinct
 * cache entry — keying on it preserves that cache-bust intent.
 *
 * Per-agent isolation is unaffected: the shared module holds only pure tool
 * DEFINITIONS; each agent's per-agent state is created when the harness calls
 * `factory(env)` with that agent's own env (see `default-harness.ts` and
 * `step-tool-harness.ts`). Sharing the module never shares agent state.
 *
 * The Promise (not the awaited value) is cached so concurrent first-callers
 * with the same integrity dedup onto a single underlying import.
 */
export function createMemoizingImportModule(
  // Substrate-required runtime import: mirrors the default in
  // @intx/tool-packaging createToolLoader (loader.ts `importModule`); we only
  // memoize the same call. The repo's no-dynamic-import rule does not apply to
  // this substrate-mandated import.
  innerImport: (url: string) => Promise<unknown> = (u) =>
    import(u) as Promise<unknown>,
): (url: string) => Promise<unknown> {
  const cache = new Map<string, Promise<unknown>>();
  return (url: string) => {
    let integrity: string | null;
    try {
      integrity = new URL(url).searchParams.get("integrity");
    } catch {
      integrity = null;
    }
    if (integrity === null) return innerImport(url);
    const existing = cache.get(integrity);
    if (existing !== undefined) return existing;
    const pending = innerImport(url);
    cache.set(integrity, pending);
    return pending;
  };
}

// One memo per sidecar process: shared across every agent's `loadToolPackages`
// call so identical-integrity tool modules are imported into the heap once.
const sharedImportModule = createMemoizingImportModule();

/**
 * Deterministic identity for a manifest's pinned closure: the sorted set of
 * `name@version:integrity` triples for every entry. Two manifests with the
 * same entries (in any order) hash identically; a republished tarball under
 * the same name@version carries a different integrity and therefore a
 * different hash, so a hot-fixed package is never served stale.
 */
export function computeManifestHash(
  manifest: typeof ToolPackageManifest.infer,
): string {
  const parts = manifest.entries
    .map((e) => `${e.name}@${e.version}:${e.integrity}`)
    .sort();
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export const DEFAULT_MAX_MANIFEST_CACHE_ENTRIES = 32;

/**
 * Memoize `loader.loadManifest(...)` per-sidecar-process, keyed by
 * `computeManifestHash`. Every launch pays the loader's full per-instance
 * cost — materialize-into-cache, hardlink the per-instance `node_modules`
 * store layout, dynamic-import each top-level entry — even when the
 * underlying tarball bytes were already extracted for a prior instance
 * (`@intx/tool-packaging`'s `TarballCache` dedups the tarball fetch/unpack
 * by integrity, but the loader still rebuilds a fresh per-instance store
 * directory and re-imports every apply). Two instances pinned to the exact
 * same closure of packages — the overwhelmingly common case, since most
 * instances of a given agent share one tenant-wide tool-package manifest —
 * gain nothing from that per-integrity dedup on the *second* instance's
 * store-layout and import work.
 *
 * This cache skips `loadManifest` entirely on a hit and hands back the
 * already-resolved `LoadedToolPackage[]` — pure factory/plugin/director
 * DEFINITIONS, never anything constructed with an agent's env (the harness
 * calls `factory(env)` per-instance, same as today; see
 * `createMemoizingImportModule`'s doc comment for why sharing the loaded
 * module is safe). A cache hit for instance B never touches instance B's
 * own per-instance scratch/store directory — that directory is a
 * `loadManifest`-internal resolution scaffold the factories do not
 * reference once imported, so skipping its construction is safe.
 *
 * Bounded LRU by entry count (`maxEntries`): each distinct manifest hash
 * seen this process gets one slot; the least-recently-used hash is evicted
 * once the bound is exceeded so a tenant that rotates through many distinct
 * manifests cannot grow this cache unboundedly. A failed load is not
 * cached — a transient failure must not poison every subsequent launch
 * with the same closure.
 */
export function createMemoizingManifestLoad(
  maxEntries: number = DEFAULT_MAX_MANIFEST_CACHE_ENTRIES,
): {
  load(
    hash: string,
    load: () => Promise<LoadedToolPackage[]>,
  ): Promise<LoadedToolPackage[]>;
  /** Test/ops seam: drop cache entries whose hash is not in `activeHashes`. */
  prune(activeHashes: ReadonlySet<string>): void;
  size(): number;
} {
  const cache = new Map<string, Promise<LoadedToolPackage[]>>();
  return {
    load(hash, loadFn) {
      const existing = cache.get(hash);
      if (existing !== undefined) {
        // Refresh LRU recency: delete + re-insert moves the key to the
        // end of Map's iteration order, which the eviction below reads
        // as "oldest first".
        cache.delete(hash);
        cache.set(hash, existing);
        return existing;
      }
      const pending = loadFn();
      // A rejected load must not squat the slot forever — the next call
      // with the same hash should retry rather than replay the failure.
      pending.catch(() => {
        cache.delete(hash);
      });
      cache.set(hash, pending);
      if (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return pending;
    },
    prune(activeHashes) {
      for (const key of [...cache.keys()]) {
        if (!activeHashes.has(key)) cache.delete(key);
      }
    },
    size() {
      return cache.size;
    },
  };
}

// One memo per sidecar process, mirroring `sharedImportModule` above: every
// agent's `loadToolPackages` call routes through the same cache so a
// second (third, ...) instance pinned to an already-seen manifest skips
// the loader's per-instance materialize/layout/import pipeline entirely.
const sharedManifestLoad = createMemoizingManifestLoad();

export function mergeToolRunners(
  runners: ToolRunner[],
): ToolRunner & { definitions: ToolDefinition[] } {
  const allDefinitions = runners.flatMap(
    (r) => (r as DefinedRunner).definitions ?? [],
  );
  const toolToRunner = new Map<string, ToolRunner>();
  for (const runner of runners) {
    const definitions = (runner as DefinedRunner).definitions ?? [];
    for (const def of definitions) {
      toolToRunner.set(def.name, runner);
    }
  }

  return {
    definitions: allDefinitions,
    async run(call, signal) {
      const runner = toolToRunner.get(call.name);
      if (!runner) {
        return {
          callId: call.id,
          content: { error: `Tool "${call.name}" is not available` },
          isError: true,
        };
      }
      return runner.run(call, signal);
    },
  };
}

/**
 * Filter a merged tool runner to only expose the tool definitions named in
 * `allowedNames`.
 */
export function filterToolRunner(
  runner: DefinedRunner,
  allowedNames: Set<string>,
): DefinedRunner {
  const filtered = runner.definitions.filter((d) => allowedNames.has(d.name));
  return {
    definitions: filtered,
    async run(call, signal) {
      if (!allowedNames.has(call.name)) {
        return {
          callId: call.id,
          content: {
            error: `Tool "${call.name}" is not enabled for this agent`,
          },
          isError: true,
        };
      }
      return runner.run(call, signal);
    },
  };
}

/**
 * Derive the hub's HTTP origin from its websocket URL.
 */
export function wsUrlToHttp(wsUrl: string): string {
  const url = new URL(wsUrl);
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//${url.host}`;
}

/**
 * Materialize the agent's pinned tool packages via the tool-packaging
 * loader. Fail-HARD: a manifest the hub wrote but the sidecar cannot parse,
 * validate, or load is an integrity fault — fail the launch loudly rather
 * than silently drop the agent's tools. No manifest (no pins) is the only
 * soft case: the agent simply has local tools only.
 */
export async function loadToolPackages(args: {
  rawManifestBytes: string | undefined;
  assetMounts: ReadonlyMap<string, string>;
  storeDir: string;
  agentAddress: string;
  cacheRoot: string;
  cacheMaxBytes: number;
  registryMaxTarballBytes: number;
  /**
   * Workspace root the loader resolves `kind: "asset"` tarball mounts
   * against. Defaults to `<storeDir>/workspace`. The on-disk deploy-tree
   * path overrides it to the step's staged deploy-tree workspace
   * (`<deployTreeDir>/workspace`, where the hub's asset-pack push lands the
   * tarballs) while keeping the apply-state + tarball cache rooted per step
   * under `storeDir` — the loader's asset source and the apply-state root
   * are then two different directories, exactly as upstream's
   * `materializeToolPackages` does it.
   */
  assetRoot?: string;
}): Promise<
  Awaited<ReturnType<ReturnType<typeof createToolLoader>["loadManifest"]>>
> {
  if (args.rawManifestBytes === undefined) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(args.rawManifestBytes);
  } catch (err) {
    throw new Error(
      `tool-package manifest for ${args.agentAddress} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const validated = ToolPackageManifest(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `tool-package manifest for ${args.agentAddress} failed validation: ${validated.summary}`,
    );
  }

  const cache = createTarballCache({
    rootDir: args.cacheRoot,
    maxBytes: args.cacheMaxBytes,
  });
  const loader = createToolLoader({
    cache,
    // Our tarballs are self-contained and asset-sourced, so no HTTP
    // registry is consulted; asset entries resolve via assetMounts.
    registries: new Map(),
    host: { os: process.platform, cpu: process.arch },
    maxRegistryTarballBytes: args.registryMaxTarballBytes,
    importModule: sharedImportModule,
  });
  const manifestHash = computeManifestHash(validated);
  return sharedManifestLoad.load(manifestHash, async () => {
    const scratchDir = path.join(args.storeDir, "tool-packages");
    await fs.promises.mkdir(scratchDir, { recursive: true });
    return loader.loadManifest({
      manifest: validated,
      instanceScratchDir: scratchDir,
      assetRoot: args.assetRoot ?? path.join(args.storeDir, "workspace"),
      assetMounts: args.assetMounts,
    });
  });
}

// Resolve provider credentials for in-sidecar tool packages over the hub's
// authenticated channel, returned as env entries keyed by
// `toolCredentialEnvKey(provider)`. Fail-soft: errors omit the entries.
export async function fetchToolCredentials(args: {
  hubHttpUrl: string;
  sidecarToken: string;
  tenantId: string;
  agentId: string;
  providerNames: readonly string[];
  agentAddress: string;
  workflowRunId?: string;
  memberPrincipalId?: string;
}): Promise<Record<string, { apiKey: string; baseURL: string }>> {
  if (args.providerNames.length === 0) return {};
  let response: Response;
  try {
    response = await fetch(
      `${args.hubHttpUrl}/api/internal/tools/credentials`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.sidecarToken}`,
        },
        body: JSON.stringify({
          tenantId: args.tenantId,
          agentId: args.agentId,
          providerNames: [...args.providerNames],
          ...(args.workflowRunId !== undefined
            ? { workflowRunId: args.workflowRunId }
            : {}),
          ...(args.memberPrincipalId !== undefined
            ? { memberPrincipalId: args.memberPrincipalId }
            : {}),
        }),
      },
    );
  } catch (err) {
    logger.warn("Tool-credential fetch failed for {address}: {msg}", {
      address: args.agentAddress,
      msg: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
  if (!response.ok) {
    logger.warn("Tool-credential fetch for {address} returned {status}", {
      address: args.agentAddress,
      status: response.status,
    });
    return {};
  }
  const parsed = ToolCredentialsResponse(await response.json());
  if (parsed instanceof type.errors) {
    logger.warn(
      "Tool-credential response for {address} failed validation: {summary}",
      {
        address: args.agentAddress,
        summary: parsed.summary,
      },
    );
    return {};
  }
  const entries: Record<string, { apiKey: string; baseURL: string }> = {};
  for (const [provider, credential] of Object.entries(parsed.credentials)) {
    entries[toolCredentialEnvKey(provider)] = credential;
  }
  return entries;
}
