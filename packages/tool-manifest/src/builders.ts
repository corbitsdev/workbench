import type { ToolSideEffect } from "./schema";
import type {
  ToolFactoryManifest,
  ToolManifestCredentialCatalog,
  ToolManifestMyraCatalog,
} from "./schema";

export type HubToolEntries = Record<
  string,
  { sideEffect: ToolSideEffect; definition?: { description?: string } }
>;

export function bareToolNamesFromEntries(entries: HubToolEntries): string[] {
  return Object.keys(entries).sort();
}

export function sideEffectsFromEntries(
  entries: HubToolEntries,
): Record<string, ToolSideEffect> {
  return Object.fromEntries(
    Object.entries(entries).map(([name, entry]) => [name, entry.sideEffect]),
  );
}

/**
 * The real per-tool manifest description (from each entry's `ToolDefinition`)
 * keyed by bare tool name. Widens the `search_tools` corpus so recall does not
 * hinge on the hand-authored friendly phrase; entries with no description are
 * omitted so a package that carries none contributes an empty map.
 */
export function descriptionsFromEntries(
  entries: HubToolEntries,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(entries)) {
    const description = entry.definition?.description;
    if (typeof description === "string" && description.trim() !== "") {
      out[name] = description;
    }
  }
  return out;
}

export function manifestFromHubToolEntries(opts: {
  factoryId: string;
  packageName: string;
  providerName?: string | null;
  entries: HubToolEntries;
  myraCatalog?: ToolManifestMyraCatalog | null;
  credentialCatalog?: ToolManifestCredentialCatalog | null;
}): ToolFactoryManifest {
  const bareToolNames = bareToolNamesFromEntries(opts.entries);
  const descriptions = descriptionsFromEntries(opts.entries);
  return {
    factoryId: opts.factoryId,
    packageName: opts.packageName,
    providerName: opts.providerName ?? null,
    bareToolNames,
    sideEffects: sideEffectsFromEntries(opts.entries),
    ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
    myraCatalog: opts.myraCatalog ?? null,
    credentialCatalog: opts.credentialCatalog ?? null,
  };
}

/**
 * Build `HubToolEntries` from a package's own runtime array of tool
 * definitions (the same array its `interchange-tools.ts` factory dispatches),
 * plus a hand-authored side-effect table. A tool added to the runtime array
 * without a matching `sideEffects` entry throws immediately at import time
 * instead of silently missing its manifest entry — the entry name itself can
 * never drift from the runtime, since it is read off `definition.name`.
 */
export function hubToolEntriesFromDefinitions(
  definitions: readonly { name: string; description?: string }[],
  sideEffects: Record<string, ToolSideEffect>,
): HubToolEntries {
  const entries: HubToolEntries = {};
  for (const definition of definitions) {
    const sideEffect = sideEffects[definition.name];
    if (sideEffect === undefined) {
      throw new Error(
        `hubToolEntriesFromDefinitions: no side effect declared for tool "${definition.name}"`,
      );
    }
    entries[definition.name] = { sideEffect, definition };
  }
  // Exact set equality, both directions: a stale key left behind by a
  // renamed/removed tool is dead weight that erodes the map's authority —
  // fail loud so the map always mirrors the runtime array exactly.
  const definitionNames = new Set(definitions.map((d) => d.name));
  for (const key of Object.keys(sideEffects)) {
    if (!definitionNames.has(key)) {
      throw new Error(
        `hubToolEntriesFromDefinitions: side-effect map declares "${key}" but no runtime tool definition has that name (stale or misspelled key)`,
      );
    }
  }
  return entries;
}

export function manifestFromBareToolNames(opts: {
  factoryId: string;
  packageName: string;
  providerName?: string | null;
  bareToolNames: readonly string[];
  sideEffects?: Record<string, ToolSideEffect>;
  descriptions?: Record<string, string>;
  myraCatalog?: ToolManifestMyraCatalog | null;
  credentialCatalog?: ToolManifestCredentialCatalog | null;
}): ToolFactoryManifest {
  const bareToolNames = [...opts.bareToolNames].sort();
  const sideEffects: Record<string, ToolSideEffect> = {};
  for (const name of bareToolNames) {
    sideEffects[name] = opts.sideEffects?.[name] ?? "read";
  }
  const descriptions: Record<string, string> = {};
  for (const name of bareToolNames) {
    const description = opts.descriptions?.[name];
    if (typeof description === "string" && description.trim() !== "") {
      descriptions[name] = description;
    }
  }
  return {
    factoryId: opts.factoryId,
    packageName: opts.packageName,
    providerName: opts.providerName ?? null,
    bareToolNames,
    sideEffects,
    ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
    myraCatalog: opts.myraCatalog ?? null,
    credentialCatalog: opts.credentialCatalog ?? null,
  };
}
