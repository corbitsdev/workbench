import {
  integrationToolProviderKey,
  toolOperationKey,
} from "@workbench/agents/browser";
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

// Brand logo filenames in the brands API library, keyed by provider. Values are
// the variant that reads on the near-black `bg-surface` (the brands-API naming:
// `name-dark`/`-light` = the explicit dark/light artwork; inherently-colored
// marks use the base file). `scrapecreators` maps to Reddit's mark because the
// Reddit tools report `providerName: "scrapecreators"` — the card should show the
// end tool (Reddit), per CL-2522.
export const PROVIDER_LOGO_FILES: Record<string, string> = {
  firecrawl: "firecrawl.svg",
  granola: "granola-light.svg",
  gamma: "gamma.svg",
  exa: "exa-dark.svg",
  reddit: "reddit.svg",
  scrapecreators: "reddit.svg",
  attio: "attio-dark.svg",
  linear: "linear.svg",
  bluesky: "bluesky.svg",
  youtube: "youtube.svg",
  xai: "xai_light.svg",
};

/**
 * Resolve the brand logo filename for a provider key, or `null` when we have no
 * mark for it (the consumer then falls back to the generic glyph).
 */
export function providerLogoFile(providerKey: string): string | null {
  return PROVIDER_LOGO_FILES[providerKey.toLowerCase()] ?? null;
}

/** Bare op ids (`exa_search`, …) when the wire name has no `provider__` prefix. */
const BARE_TOOL_PROVIDER_PREFIXES: ReadonlySet<string> = new Set([
  "attio",
  "bluesky",
  "exa",
  "firecrawl",
  "gamma",
  "github",
  "granola",
  "linear",
  "notion",
  "reddit",
  "slack",
  "sumble",
  "vercel",
  "xai",
  "youtube",
]);

export function providerKeyForToolLogo(
  toolName: string,
  args?: Record<string, unknown>,
): string | null {
  const fromWire = integrationToolProviderKey(toolName, args);
  if (fromWire !== null) return fromWire;
  const prefix = toolOperationKey(toolName).split("_")[0]?.toLowerCase();
  if (prefix !== undefined && BARE_TOOL_PROVIDER_PREFIXES.has(prefix)) {
    return prefix;
  }
  return null;
}

/**
 * Resolve the brands-library filename for a tool invocation, or null when we
 * cannot attribute the call to a known provider mark.
 */
export function toolProviderLogoFilename(
  toolName: string,
  args?: Record<string, unknown>,
): string | null {
  const providerKey = providerKeyForToolLogo(toolName, args);
  if (providerKey === null) return null;
  return providerLogoFile(providerKey);
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
