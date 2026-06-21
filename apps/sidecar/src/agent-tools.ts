// Tool-package materialization + tool-credential resolution shared by the
// live-agent harness (`default-harness.ts`) and the workflow-step harness
// (`step-tool-harness.ts`). Both paths load the agent's pinned tool packages
// from the same `@intx/tool-packaging` loader, resolve the provider
// credentials those packages declare over the hub's authenticated channel,
// and merge/filter the resulting runners — so the two paths cannot drift in
// how a tool becomes available to an agent.

import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import { createTarballCache, createToolLoader } from "@intx/tool-packaging";
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
  const scratchDir = path.join(args.storeDir, "tool-packages");
  await fs.promises.mkdir(scratchDir, { recursive: true });
  return loader.loadManifest({
    manifest: validated,
    instanceScratchDir: scratchDir,
    assetRoot: path.join(args.storeDir, "workspace"),
    assetMounts: args.assetMounts,
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
