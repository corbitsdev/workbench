import { resolveCredentialRequirement } from '@intx/db';
import { getLogger } from '@intx/log';
import type { HubDb } from '../db';
import {
  KNOWN_TOOLS,
  isCredentialToolEntry,
  type ToolEntry,
  type ToolSummary,
} from './tool-registry';

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

const log = getLogger(['api', 'tenant-tools']);

function summaryFor(name: string, entry: ToolEntry): ToolSummary {
  return {
    name,
    providerName: isCredentialToolEntry(entry) ? entry.providerName : 'workbench',
    description: entry.definition.description ?? '',
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
  providerName: string
): Promise<boolean> {
  try {
    const resolved = await resolveCredentialRequirement(
      db,
      tenantId,
      { providerName, source: 'tenant' },
      null,
      null
    );
    return resolved !== null;
  } catch (error) {
    log.warn('credential resolution failed; hiding provider from the catalog', {
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
  wanted: Set<string>
): Promise<Set<string>> {
  const available = new Set<string>();
  await Promise.all(
    [...wanted].map(async (providerName) => {
      if (await providerAvailable(db, tenantId, providerName)) available.add(providerName);
    })
  );
  return available;
}

/** Summaries of every tool the tenant can run, for the gallery list view. */
export async function listAvailableToolSummaries(
  db: HubDb,
  tenantId: string
): Promise<ToolSummary[]> {
  const available = await resolveAvailableProviderNames(db, tenantId, credentialProviderNames());
  return Object.entries(KNOWN_TOOLS)
    .filter(([, entry]) => !isCredentialToolEntry(entry) || available.has(entry.providerName))
    .map(([name, entry]) => summaryFor(name, entry));
}

export type ToolDetail = ToolSummary & { inputSchema: unknown };

/** Detail for one tool, or null if it does not exist or the tenant cannot run it. */
export async function getAvailableToolDetail(
  db: HubDb,
  tenantId: string,
  name: string
): Promise<ToolDetail | null> {
  const entry = KNOWN_TOOLS[name];
  if (entry === undefined) return null;
  if (
    isCredentialToolEntry(entry) &&
    !(await providerAvailable(db, tenantId, entry.providerName))
  ) {
    return null;
  }
  return { ...summaryFor(name, entry), inputSchema: entry.definition.inputSchema ?? null };
}
