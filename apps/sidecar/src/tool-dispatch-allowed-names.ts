/** Pure helper: which tool names may be dispatched after hub grant narrowing (CL-3762). */
export function buildDispatchAllowedToolNames(
  grantedToolNames: readonly string[],
  loadedToolNames: Iterable<string>,
  catalogToolNames: readonly string[],
): Set<string> {
  const grantedCatalogToolNames = new Set(grantedToolNames);
  const allowedNames = new Set([
    ...grantedToolNames,
    ...catalogToolNames,
  ]);
  for (const name of loadedToolNames) {
    if (grantedCatalogToolNames.has(name)) {
      allowedNames.add(name);
    }
  }
  return allowedNames;
}