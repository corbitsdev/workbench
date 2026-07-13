import type { ToolSideEffect } from "./schema";
import type {
  ToolFactoryManifest,
  ToolManifestCredentialCatalog,
  ToolManifestMyraCatalog,
} from "./schema";

export type HubToolEntries = Record<string, { sideEffect: ToolSideEffect }>;

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

export function manifestFromHubToolEntries(opts: {
  factoryId: string;
  packageName: string;
  providerName?: string | null;
  entries: HubToolEntries;
  myraCatalog?: ToolManifestMyraCatalog | null;
  credentialCatalog?: ToolManifestCredentialCatalog | null;
}): ToolFactoryManifest {
  const bareToolNames = bareToolNamesFromEntries(opts.entries);
  return {
    factoryId: opts.factoryId,
    packageName: opts.packageName,
    providerName: opts.providerName ?? null,
    bareToolNames,
    sideEffects: sideEffectsFromEntries(opts.entries),
    myraCatalog: opts.myraCatalog ?? null,
    credentialCatalog: opts.credentialCatalog ?? null,
  };
}

export function manifestFromBareToolNames(opts: {
  factoryId: string;
  packageName: string;
  providerName?: string | null;
  bareToolNames: readonly string[];
  sideEffects?: Record<string, ToolSideEffect>;
  myraCatalog?: ToolManifestMyraCatalog | null;
  credentialCatalog?: ToolManifestCredentialCatalog | null;
}): ToolFactoryManifest {
  const bareToolNames = [...opts.bareToolNames].sort();
  const sideEffects: Record<string, ToolSideEffect> = {};
  for (const name of bareToolNames) {
    sideEffects[name] = opts.sideEffects?.[name] ?? "read";
  }
  return {
    factoryId: opts.factoryId,
    packageName: opts.packageName,
    providerName: opts.providerName ?? null,
    bareToolNames,
    sideEffects,
    myraCatalog: opts.myraCatalog ?? null,
    credentialCatalog: opts.credentialCatalog ?? null,
  };
}
