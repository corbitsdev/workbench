import type { ToolFactoryManifest } from "./schema";

export function sortFactoryManifests(
  factories: readonly ToolFactoryManifest[],
): ToolFactoryManifest[] {
  return [...factories].sort((a, b) => {
    const byPackage = a.packageName.localeCompare(b.packageName, "en");
    if (byPackage !== 0) return byPackage;
    return a.factoryId.localeCompare(b.factoryId, "en");
  });
}

export function derivePackageTools(
  factories: readonly ToolFactoryManifest[],
): Record<string, readonly string[]> {
  const out: Record<string, string[]> = {};
  for (const manifest of factories) {
    out[manifest.factoryId] = [...manifest.bareToolNames].sort();
  }
  return out;
}

export function derivePackageProviders(
  factories: readonly ToolFactoryManifest[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const manifest of factories) {
    if (manifest.providerName == null || manifest.providerName === "") continue;
    const pin = manifest.packageName;
    if (out[pin] !== undefined && out[pin] !== manifest.providerName) {
      throw new Error(
        `Package ${pin} declares conflicting providers: ${out[pin]} vs ${manifest.providerName}`,
      );
    }
    out[pin] = manifest.providerName;
  }
  return out;
}

export type DerivedMyraCatalogPackage = {
  pin: string;
  package: string;
  summary: string;
  tags: string[];
};

export function deriveMyraCatalogPackages(
  factories: readonly ToolFactoryManifest[],
): DerivedMyraCatalogPackage[] {
  const byPin = new Map<string, DerivedMyraCatalogPackage>();
  for (const manifest of factories) {
    if (manifest.myraCatalog == null) continue;
    const existing = byPin.get(manifest.packageName);
    const next: DerivedMyraCatalogPackage = {
      pin: manifest.packageName,
      package: manifest.myraCatalog.catalogPackage,
      summary: manifest.myraCatalog.summary,
      tags: [...manifest.myraCatalog.tags],
    };
    if (existing !== undefined) {
      if (
        existing.package !== next.package ||
        existing.summary !== next.summary
      ) {
        throw new Error(
          `Package ${manifest.packageName} has conflicting myraCatalog metadata`,
        );
      }
      const priorTags = [...existing.tags].sort().join("\0");
      const nextTags = [...next.tags].sort().join("\0");
      if (priorTags !== nextTags) {
        throw new Error(
          `Package ${manifest.packageName} has conflicting myraCatalog tags across factories`,
        );
      }
      continue;
    }
    byPin.set(manifest.packageName, next);
  }
  return [...byPin.values()].sort((a, b) => a.pin.localeCompare(b.pin));
}

export type DerivedToolCredentialCatalogEntry = {
  providerName: string;
  label: string;
  secretLabel?: string;
  secondaryField?: {
    label: string;
    placeholder: string;
    required: boolean;
  };
  platforms?: string[];
};

export function deriveToolCredentialCatalogEntries(
  factories: readonly ToolFactoryManifest[],
): DerivedToolCredentialCatalogEntry[] {
  const byProvider = new Map<string, DerivedToolCredentialCatalogEntry>();
  for (const manifest of factories) {
    if (manifest.credentialCatalog == null) continue;
    if (manifest.providerName == null || manifest.providerName === "") {
      throw new Error(
        `Factory ${manifest.factoryId} has credentialCatalog but no providerName`,
      );
    }
    const providerName = manifest.providerName;
    const entry: DerivedToolCredentialCatalogEntry = {
      providerName,
      label: manifest.credentialCatalog.label,
      ...(manifest.credentialCatalog.secretLabel !== undefined
        ? { secretLabel: manifest.credentialCatalog.secretLabel }
        : {}),
      ...(manifest.credentialCatalog.secondaryField !== undefined
        ? { secondaryField: manifest.credentialCatalog.secondaryField }
        : {}),
      ...(manifest.credentialCatalog.platforms !== undefined
        ? { platforms: [...manifest.credentialCatalog.platforms] }
        : {}),
    };
    const existing = byProvider.get(providerName);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(entry)) {
        throw new Error(
          `Provider ${providerName} has conflicting credentialCatalog metadata`,
        );
      }
      continue;
    }
    byProvider.set(providerName, entry);
  }
  return [...byProvider.values()].sort((a, b) =>
    a.providerName.localeCompare(b.providerName),
  );
}

/**
 * Real per-tool manifest descriptions grouped by package name, merged across a
 * package's factories. Feeds the catalog's `search_tools` keyword corpus so
 * recall matches on the tool's true description, not only the friendly phrase.
 */
export function deriveBareToolDescriptions(
  factories: readonly ToolFactoryManifest[],
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const manifest of factories) {
    if (manifest.descriptions === undefined) continue;
    const bucket = (out[manifest.packageName] ??= {});
    for (const [name, description] of Object.entries(manifest.descriptions)) {
      bucket[name] = description;
    }
  }
  return out;
}

export function flatBareToolNames(
  factories: readonly ToolFactoryManifest[],
): string[] {
  return factories.flatMap((m) => m.bareToolNames).sort();
}

/** Every bare tool name classified `sideEffect: "write"` in committed manifests. */
export function writeBareToolNamesFromFactories(
  factories: readonly ToolFactoryManifest[],
): string[] {
  const out: string[] = [];
  for (const manifest of factories) {
    for (const name of manifest.bareToolNames) {
      if (manifest.sideEffects[name] === "write") {
        out.push(name);
      }
    }
  }
  return out.sort();
}
