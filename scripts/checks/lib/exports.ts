// Pure helpers over a package.json "exports" field, used by the
// package-hygiene check.

import { type } from "arktype";

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

// The one slice of a package.json this checker reads.
const DependencyBearer = type({ "dependencies?": "Record<string, string>" });

/** Names in "dependencies" — the packages a consumer install provides. */
export function declaredDependencyNames(packageJson: unknown): string[] {
  const parsed = DependencyBearer(packageJson);
  if (parsed instanceof type.errors) return [];
  return Object.keys(parsed.dependencies ?? {});
}
