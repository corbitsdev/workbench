import { MYRA_TOOL_CATALOG } from "./dynamic-tools-catalog";

/** LLM tool names disabled because their whole catalog package is turned off. */
export function catalogToolNamesForPackages(
  disabledCatalogPackages: ReadonlySet<string>,
): Set<string> {
  const names = new Set<string>();
  if (disabledCatalogPackages.size === 0) return names;
  for (const entry of MYRA_TOOL_CATALOG) {
    if (!disabledCatalogPackages.has(entry.package)) continue;
    for (const tool of entry.tools) names.add(tool.name);
  }
  return names;
}

/**
 * Intersect the workspace grant set with per-member Myra tool narrowing
 * (disabled catalog packages and/or individual catalog tool names). Never widens
 * `grantedToolNames`; unknown disabled ids are ignored at narrow time.
 */
export function narrowMyraToolNamesByMemberPreference(
  grantedToolNames: readonly string[],
  disabledCatalogPackages: readonly string[],
  disabledToolNames: readonly string[],
): string[] {
  const disabledPackages = new Set(disabledCatalogPackages);
  const disabledTools = new Set(disabledToolNames);
  const fromPackages = catalogToolNamesForPackages(disabledPackages);
  return grantedToolNames.filter(
    (name) => !fromPackages.has(name) && !disabledTools.has(name),
  );
}

export const MYRA_CATALOG_PACKAGE_KEYS: readonly string[] =
  MYRA_TOOL_CATALOG.map((e) => e.package);

const CATALOG_TOOL_NAME_SET = new Set<string>(
  MYRA_TOOL_CATALOG.flatMap((e) => e.tools.map((t) => t.name)),
);

export function isMyraCatalogPackageKey(packageKey: string): boolean {
  return MYRA_CATALOG_PACKAGE_KEYS.includes(packageKey);
}

export function isMyraCatalogManagedToolName(toolName: string): boolean {
  return CATALOG_TOOL_NAME_SET.has(toolName);
}
