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
 * definitions (the same array its `interchange-tools.ts` factory dispatches).
 * Each definition carries its own `sideEffect` inline — the classification is
 * authored once, next to the tool it describes, so it can never drift from
 * the runtime array the way a parallel hand-authored map could.
 */
export function hubToolEntriesFromDefinitions<
  D extends { name: string; description?: string; sideEffect: ToolSideEffect },
>(definitions: readonly D[]): HubToolEntries {
  const entries: HubToolEntries = {};
  for (const definition of definitions) {
    entries[definition.name] = {
      sideEffect: definition.sideEffect,
      definition,
    };
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
