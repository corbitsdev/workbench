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
