import { PAGE_CONTEXT_CATALOG, PAGE_CONTEXT_FALLBACK } from "./catalog";

/**
 * Resolve maintained page context for a React Router pathname (no search/hash).
 * More specific catalog entries are listed first in the catalog file.
 */
export function pageContextForPathname(pathname: string): string {
  const path = pathname.split("?")[0]?.split("#")[0] ?? "/";
  for (const entry of PAGE_CONTEXT_CATALOG) {
    if (entry.match(path)) return entry.context;
  }
  return PAGE_CONTEXT_FALLBACK;
}

/** Catalog ids — useful for docs and completeness checks in tests. */
export function listPageContextCatalogIds(): string[] {
  return PAGE_CONTEXT_CATALOG.map((e) => e.id);
}
