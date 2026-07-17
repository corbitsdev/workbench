/**
 * Pure helper: which tool names may be dispatched after hub grant narrowing
 * (CL-3762). A loaded package tool is admitted when it appears in either grant
 * source — the hub-proxy/local grant names or the catalog grant set. When
 * `grantedCatalogToolNames` is undefined the agent has no dynamic catalog
 * (workflow/step agents): every loaded tool is admitted, preserving their
 * full-advertisement contract (CL-3848).
 */
export function buildDispatchAllowedToolNames(
  grantedToolNames: readonly string[],
  loadedToolNames: Iterable<string>,
  catalogToolNames: readonly string[],
  grantedCatalogToolNames: ReadonlySet<string> | undefined,
): Set<string> {
  const allowedNames = new Set([...grantedToolNames, ...catalogToolNames]);
  if (grantedCatalogToolNames === undefined) {
    for (const name of loadedToolNames) allowedNames.add(name);
    return allowedNames;
  }
  const granted = new Set([...grantedToolNames, ...grantedCatalogToolNames]);
  for (const name of loadedToolNames) {
    if (granted.has(name)) allowedNames.add(name);
  }
  return allowedNames;
}
