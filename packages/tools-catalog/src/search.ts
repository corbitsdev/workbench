import type { ToolCatalog, ToolCatalogEntry, ToolCatalogTool } from "./schema";

/** Every LLM-facing tool name the catalog manages, across all packages. */
export function catalogManagedNames(catalog: ToolCatalog): Set<string> {
  const names = new Set<string>();
  for (const entry of catalog) {
    for (const tool of entry.tools) names.add(tool.name);
  }
  return names;
}

/**
 * Restrict a catalog to the tools that actually loaded for this agent.
 * `availableNames` is the set of LLM-facing tool names the harness
 * materialized successfully; a package whose credential is missing is dropped
 * fail-soft at construction, so none of its tools appear there. An entry keeps
 * only its available tools and is omitted entirely once none remain — so
 * `search_tools` never advertises a package the agent cannot call.
 */
export function filterCatalogByAvailableTools(
  catalog: ToolCatalog,
  availableNames: ReadonlySet<string>,
): ToolCatalog {
  const filtered: ToolCatalog = [];
  for (const entry of catalog) {
    const tools = entry.tools.filter((tool) => availableNames.has(tool.name));
    if (tools.length > 0) filtered.push({ ...entry, tools });
  }
  return filtered;
}

export type SearchToolsQuery = {
  query: string;
  package?: string;
  tags?: string[];
};

export type SearchToolMatch = {
  name: string;
  description: string;
  score: number;
};

export type SearchPackageMatch = {
  package: string;
  summary: string;
  tags: string[];
  score: number;
  tools: SearchToolMatch[];
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function toTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function scoreTool(tool: ToolCatalogTool, terms: string[]): number {
  if (terms.length === 0) return 1;
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  const keywords = (tool.keywords ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 3 * countOccurrences(name, term);
    if (description.includes(term))
      score += countOccurrences(description, term);
    if (keywords.includes(term)) score += countOccurrences(keywords, term);
  }
  return score;
}

function scoreEntry(
  entry: ToolCatalogEntry,
  terms: string[],
): { score: number; tools: SearchToolMatch[] } {
  const pkg = entry.package.toLowerCase();
  const summary = entry.summary.toLowerCase();
  const tags = entry.tags.map((t) => t.toLowerCase());

  let packageScore = 0;
  for (const term of terms) {
    if (pkg.includes(term)) packageScore += 5;
    if (summary.includes(term))
      packageScore += 2 * countOccurrences(summary, term);
    if (tags.some((tag) => tag.includes(term))) packageScore += 3;
  }

  const tools: SearchToolMatch[] = entry.tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      score: scoreTool(tool, terms),
    }))
    .filter((t) => terms.length === 0 || t.score > 0)
    .sort((a, b) => b.score - a.score);

  const toolScore = tools.reduce((sum, t) => sum + t.score, 0);
  return { score: packageScore + toolScore, tools };
}

/**
 * Deterministic keyword/substring search over the catalog. When the query has
 * no scorable terms every package matches (a browse). A `package` filter
 * restricts to one package key; `tags` requires the entry to carry at least
 * one of the named tags.
 */
export function searchCatalog(
  catalog: ToolCatalog,
  { query, package: pkg, tags }: SearchToolsQuery,
): SearchPackageMatch[] {
  const terms = toTerms(query);
  const wantTags = (tags ?? []).map((t) => t.toLowerCase());

  const matches: SearchPackageMatch[] = [];
  for (const entry of catalog) {
    if (pkg !== undefined && entry.package !== pkg) continue;
    if (
      wantTags.length > 0 &&
      !entry.tags.some((tag) => wantTags.includes(tag.toLowerCase()))
    ) {
      continue;
    }
    const { score, tools } = scoreEntry(entry, terms);
    if (terms.length > 0 && score <= 0) continue;
    matches.push({
      package: entry.package,
      summary: entry.summary,
      tags: entry.tags,
      score,
      tools:
        terms.length > 0
          ? tools
          : entry.tools.map((t) => ({
              name: t.name,
              description: t.description,
              score: 0,
            })),
    });
  }
  return matches.sort((a, b) => b.score - a.score);
}

export type ResolveLoadRequest = {
  names?: string[];
  package?: string;
};

export type ResolveLoadResult = {
  resolved: string[];
  unknownNames: string[];
  unknownPackage: string | null;
};

/**
 * Resolve a `load_tools` request into the concrete LLM-facing tool names to
 * expose. Explicit `names` are matched against the catalog's managed names; a
 * `package` key expands to every tool the entry lists. Unmatched inputs are
 * reported so the handler can surface them rather than silently dropping them.
 */
export function resolveLoadRequest(
  catalog: ToolCatalog,
  { names, package: pkg }: ResolveLoadRequest,
): ResolveLoadResult {
  const managed = catalogManagedNames(catalog);
  const resolved = new Set<string>();
  const unknownNames: string[] = [];

  for (const name of names ?? []) {
    if (managed.has(name)) {
      resolved.add(name);
    } else {
      unknownNames.push(name);
    }
  }

  let unknownPackage: string | null = null;
  if (pkg !== undefined) {
    const entry = catalog.find((e) => e.package === pkg);
    if (entry === undefined) {
      unknownPackage = pkg;
    } else {
      for (const tool of entry.tools) resolved.add(tool.name);
    }
  }

  return {
    resolved: [...resolved],
    unknownNames,
    unknownPackage,
  };
}
