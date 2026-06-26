import { toHumanLabel } from "@workbench/ui";

// Canonical display labels for tool providers, keyed by the lowercase provider
// key (a tool factory id prefix such as `firecrawl_search` -> `firecrawl`, or a
// `ToolSummary.providerName`). Hoisted here so the catalog modal and the Tools
// library share one source of truth instead of duplicating the map.
export const TOOL_PROVIDER_LABELS: Record<string, string> = {
  granola: "Granola",
  firecrawl: "Firecrawl",
  gamma: "Gamma",
  exa: "Exa",
  reddit: "Reddit",
  scrapecreators: "ScrapeCreators",
  attio: "Attio",
  linear: "Linear",
  bluesky: "Bluesky",
};

/**
 * Resolve a human display label for a provider key. Falls back to the shared
 * `toHumanLabel` humanizer when the key is not in the curated map, so newly
 * added providers still render a sensible label.
 */
export function providerLabel(providerKey: string): string {
  const key = providerKey.toLowerCase();
  return TOOL_PROVIDER_LABELS[key] ?? toHumanLabel(providerKey);
}

/**
 * Derive the ordered, de-duplicated set of provider labels referenced by a list
 * of tool factory ids (e.g. `firecrawl_search`). Only providers present in the
 * curated map are surfaced — unknown prefixes are skipped.
 */
export function deriveProviderLabels(tools: string[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const tool of tools) {
    const prefix = tool.split("_")[0];
    if (prefix && TOOL_PROVIDER_LABELS[prefix] && !seen.has(prefix)) {
      seen.add(prefix);
      labels.push(TOOL_PROVIDER_LABELS[prefix]!);
    }
  }
  return labels;
}
