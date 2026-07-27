import type { ToolFactoryManifest } from "./schema";

export function assertToolManifestFactoryInvariants(
  factories: readonly ToolFactoryManifest[],
): void {
  const factoryIds = new Set<string>();
  const bareNameOwner = new Map<string, string>();

  for (const manifest of factories) {
    if (factoryIds.has(manifest.factoryId)) {
      throw new Error(
        `Duplicate factoryId in tool manifest index: ${manifest.factoryId}`,
      );
    }
    factoryIds.add(manifest.factoryId);

    const bareSet = new Set(manifest.bareToolNames);
    const effectKeys = Object.keys(manifest.sideEffects);
    if (effectKeys.length !== bareSet.size) {
      throw new Error(
        `Factory ${manifest.factoryId}: sideEffects keys must match bareToolNames exactly`,
      );
    }
    for (const name of bareSet) {
      if (manifest.sideEffects[name] === undefined) {
        throw new Error(
          `Factory ${manifest.factoryId}: missing sideEffects for bare tool ${name}`,
        );
      }
    }
    for (const key of effectKeys) {
      if (!bareSet.has(key)) {
        throw new Error(
          `Factory ${manifest.factoryId}: sideEffects key ${key} is not a bare tool name`,
        );
      }
    }

    for (const name of manifest.bareToolNames) {
      const owner = bareNameOwner.get(name);
      if (owner !== undefined) {
        throw new Error(
          `Bare tool name ${name} is declared by both ${owner} and ${manifest.factoryId}`,
        );
      }
      bareNameOwner.set(name, manifest.factoryId);
    }
  }
}
