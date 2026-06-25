import { resolveCredentialRequirement, listAssetsForTenant } from "@intx/db";
import { getLogger } from "@intx/log";
import { createClosureResolver } from "@intx/tool-packaging";
import {
  WORKSPACE_BUILTINS_REGISTRY,
  type AssetService,
} from "@intx/hub-sessions";
import { toolPackagesForCapabilities } from "@workbench/agents";
import type { HubDb } from "../db";
import { buildTenantRegistryMap } from "./tenant-registry-map";
import {
  KNOWN_TOOLS,
  isCredentialToolEntry,
  type ToolEntry,
  type ToolSummary,
} from "./tool-registry";

/**
 * Tenant-scoped tool availability. A credential tool is available to a tenant
 * only when its provider resolves a tenant-owned credential up the hierarchy;
 * context/hub-backed tools (no provider) are always available. The catalog the
 * web "Tools" gallery shows is therefore the set of tools the tenant can
 * actually run, not the global registry.
 *
 * Availability is decided by the SAME `resolveCredentialRequirement` the
 * launch path uses (source 'tenant'), so the gallery cannot disagree with
 * launch on child-shadows-parent provider resolution. Distinct providers are
 * resolved once each (the registry has a single-digit number of them).
 */

const log = getLogger(["api", "tenant-tools"]);

function summaryFor(name: string, entry: ToolEntry): ToolSummary {
  return {
    name,
    providerName: isCredentialToolEntry(entry)
      ? entry.providerName
      : "workbench",
    description: entry.definition.description ?? "",
  };
}

/** Distinct provider names referenced by credential tools in the registry. */
function credentialProviderNames(): Set<string> {
  const names = new Set<string>();
  for (const entry of Object.values(KNOWN_TOOLS)) {
    if (isCredentialToolEntry(entry)) names.add(entry.providerName);
  }
  return names;
}

/**
 * Whether the tenant can run tools for `providerName`. Uses the launch-time
 * resolver, which throws on an ambiguous match (>1 credential) — the same
 * config that would fail an actual launch. We treat any throw (ambiguity or a
 * DB error) as "not cleanly runnable" and hide the tool (fail-closed), logging
 * so the decision is observable rather than masked as available.
 */
async function providerAvailable(
  db: HubDb,
  tenantId: string,
  providerName: string,
): Promise<boolean> {
  try {
    const resolved = await resolveCredentialRequirement(
      db,
      tenantId,
      { providerName, source: "tenant" },
      null,
      null,
    );
    return resolved !== null;
  } catch (error) {
    log.warn("credential resolution failed; hiding provider from the catalog", {
      providerName,
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function resolveAvailableProviderNames(
  db: HubDb,
  tenantId: string,
  wanted: Set<string>,
): Promise<Set<string>> {
  const available = new Set<string>();
  await Promise.all(
    [...wanted].map(async (providerName) => {
      if (await providerAvailable(db, tenantId, providerName))
        available.add(providerName);
    }),
  );
  return available;
}

/** Summaries of every tool the tenant can run, for the gallery list view. */
export async function listAvailableToolSummaries(
  db: HubDb,
  tenantId: string,
): Promise<ToolSummary[]> {
  const available = await resolveAvailableProviderNames(
    db,
    tenantId,
    credentialProviderNames(),
  );
  return Object.entries(KNOWN_TOOLS)
    .filter(
      ([, entry]) =>
        !isCredentialToolEntry(entry) || available.has(entry.providerName),
    )
    .map(([name, entry]) => summaryFor(name, entry));
}

export type ToolDetail = ToolSummary & { inputSchema: unknown };

/** Detail for one tool, or null if it does not exist or the tenant cannot run it. */
export async function getAvailableToolDetail(
  db: HubDb,
  tenantId: string,
  name: string,
): Promise<ToolDetail | null> {
  const entry = KNOWN_TOOLS[name];
  if (entry === undefined) return null;
  if (
    isCredentialToolEntry(entry) &&
    !(await providerAvailable(db, tenantId, entry.providerName))
  ) {
    return null;
  }
  return {
    ...summaryFor(name, entry),
    inputSchema: entry.definition.inputSchema ?? null,
  };
}

function packageForTool(toolName: string): string | null {
  const pins = toolPackagesForCapabilities([toolName]);
  return pins[0]?.name ?? null;
}

/**
 * Resolves the registry version for each tool name by mapping tools to their
 * npm package, then resolving the closure against the tenant's package-registry
 * asset. The returned map is keyed by TOOL NAME (not package): the route reads
 * `version` per summary without re-deriving the package pin. Returns an empty
 * map when no registry asset exists or resolution fails; the route degrades to
 * version: null rather than erroring. Tool names that map to no package, or to a
 * package the closure didn't pin at top level, are simply absent from the map.
 */
export async function resolveToolVersions(
  db: HubDb,
  tenantId: string,
  toolNames: string[],
  assetService: AssetService,
): Promise<Map<string, string>> {
  const pins = toolPackagesForCapabilities(toolNames);
  if (pins.length === 0) return new Map();

  const visibleAssets = await listAssetsForTenant(
    db,
    tenantId,
    "package-registry",
  );
  const { registryMap } = buildTenantRegistryMap(visibleAssets, assetService);
  if (!registryMap.has(WORKSPACE_BUILTINS_REGISTRY)) return new Map();

  let manifest: Awaited<
    ReturnType<ReturnType<typeof createClosureResolver>["resolveClosure"]>
  >;
  try {
    manifest = await createClosureResolver({
      registries: registryMap,
      defaultRegistry: WORKSPACE_BUILTINS_REGISTRY,
    }).resolveClosure(pins);
  } catch (err) {
    log.error("Registry closure resolution failed during version lookup", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }

  // Use `topLevel` (the explicitly-pinned packages), not `entries` (the full
  // transitive closure): the tool's own version must be its top-level pin, and a
  // transitive dep sharing a name must never shadow it.
  const versionByPackage = new Map<string, string>();
  for (const pin of manifest.topLevel) {
    versionByPackage.set(pin.name, pin.version);
  }

  const versionByTool = new Map<string, string>();
  for (const toolName of toolNames) {
    const pkg = packageForTool(toolName);
    if (pkg === null) continue;
    const version = versionByPackage.get(pkg);
    if (version !== undefined) versionByTool.set(toolName, version);
  }
  return versionByTool;
}
