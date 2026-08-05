// Pure helpers over a package.json "exports" field, used by the
// package-hygiene check.

/**
 * Every relative file path an "exports" field promises, across all
 * subpaths and conditions. These are the files a published artifact
 * must actually contain.
 */
export function collectExportTargets(exportsField: unknown): string[] {
  const targets = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith("./")) targets.add(value);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) walk(child);
    }
  };
  walk(exportsField);
  return [...targets];
}

/** Names in "dependencies" — the packages a consumer install provides. */
export function declaredDependencyNames(packageJson: unknown): string[] {
  if (typeof packageJson !== "object" || packageJson === null) return [];
  const dependencies = (packageJson as Record<string, unknown>).dependencies;
  if (typeof dependencies !== "object" || dependencies === null) return [];
  return Object.keys(dependencies);
}
