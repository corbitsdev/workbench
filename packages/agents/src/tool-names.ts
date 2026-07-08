import type { ToolPackagePin } from "@intx/types/tool-packages";

// Canonical (namespace-prefixed) tool names for native tool packages.
//
// The sidecar tool-packaging loader prefixes every tool definition name with
// its package factory id (`<factoryId>:<name>`), and the authz layer grants and
// checks `tool:<runtime name>` at invoke time. Agent capability lists must
// therefore carry the prefixed name so the grants the hub seeds from them match
// what the runtime asks for (CL-2145). Local sidecar runners — posix
// (`read_file`, `write_file`, `edit_file`, `search_files`, `run_shell`, `grep`),
// mail (`mail_*`), ask-principal — are merged directly (not loaded as packages)
// and are NOT prefixed; they pass through unchanged.
//
// This table mirrors each package's `interchange.tools` factory id and the tool
// definition names it exports. Keep it in sync when a tool package adds, renames,
// or removes a tool. Names not present here (locals, or not-yet-real tools) are
// returned verbatim.

const PACKAGE_TOOLS: Record<string, readonly string[]> = {
  "@workbench/tools-agents/agents": [
    "list_agents",
    "list_principals",
    "identity_get",
    "identity_set",
  ],
  "@workbench/tools-ab-compare/compose": [
    "ab_preset_quorum",
    "ab_preset_compose",
  ],
  "@workbench/tools-attio/attio": [
    "attio_list_objects",
    "attio_query_records",
    "attio_search_records",
    "attio_get_record",
    "attio_list_workspace_members",
    "attio_list_tasks",
    "attio_get_task",
    "attio_update_task",
    "attio_create_note",
  ],
  "@workbench/tools-artifact/artifact": [
    "artifact_create",
    "artifact_read",
    "artifact_read_chunk",
    "artifact_write",
    "artifact_list",
    "artifact_find_by_title",
    "artifact_link_file",
    "artifact_link_presentation",
    "artifact_link_gamma_presentation",
    "write_artifact",
    "memory_load",
    "memory_save",
  ],
  "@workbench/tools-bluesky/bluesky": ["bluesky_search"],
  "@workbench/tools-fileparser/fileparser": ["parse_file"],
  "@workbench/tools-dispatch/dispatch": ["dispatch_agent"],
  "@workbench/tools-exa/exa": ["exa_search", "web_search"],
  "@workbench/tools-firecrawl/firecrawl": [
    "firecrawl_scrape",
    "firecrawl_search",
    "firecrawl_map",
    "firecrawl_crawl_start",
    "firecrawl_crawl_status",
    "firecrawl_batch_scrape_start",
    "firecrawl_batch_scrape_status",
    "firecrawl_extract_start",
    "firecrawl_extract_status",
    "firecrawl_agent",
    "firecrawl_parse",
    "firecrawl_credit_usage",
    "firecrawl_token_usage",
  ],
  "@workbench/tools-gamma/gamma": [
    "gamma_create_from_template",
    "gamma_duplicate_presentation",
    "gamma_list_themes",
  ],
  // Hub-backed (reads tenant templates from the hub DB, no Gamma credential);
  // shipped in the same @workbench/tools-gamma tarball as its own factory.
  "@workbench/tools-gamma/gamma-templates": ["gamma_list_templates"],
  "@workbench/tools-github/github": ["github_activity"],
  "@workbench/tools-granola/granola": [
    "granola_list_notes",
    "granola_get_note",
    "granola_list_folders",
  ],
  "@workbench/tools-hackernews/hackernews": ["hackernews_search"],
  "@workbench/tools-linear/linear": [
    "linear_list_issues",
    "linear_get_issue",
    "linear_list_teams",
    "linear_list_users",
  ],
  "@workbench/tools-notion/notion": [
    "notion_search",
    "notion_get_page",
    "notion_get_page_content",
    "notion_get_database",
    "notion_query_database",
    "notion_create_page",
  ],
  "@workbench/tools-vercel/vercel": [
    "vercel_list_projects",
    "vercel_list_deployments",
    "vercel_deploy_static_file",
  ],
  "@workbench/tools-vercel/deploy-artifact": ["vercel_deploy_artifact"],
  "@workbench/tools-last30days/core": [
    "last30days_core_extract",
    "last30days_core_report",
    "last30days_ground_queries",
    "last30days_entity_queries",
    "last30days_collect",
    "last30days_validate",
    "last30days_workflow_brief",
  ],
  "@workbench/tools-polymarket/polymarket": ["polymarket_odds"],
  "@workbench/tools-reddit/reddit": [
    "reddit_search",
    "reddit_subreddit_search",
  ],
  "@workbench/tools-scrapecreators/scrapecreators": [
    "scrapecreators_tiktok",
    "scrapecreators_instagram",
    "scrapecreators_threads",
    "scrapecreators_pinterest",
  ],
  "@workbench/tools-skills/skills": [
    "list_skills",
    "search_skills",
    "load_skill",
    "skill_draft",
  ],
  "@workbench/tools-workflows/workflows": [
    "workflow_list_kinds",
    "workflow_start",
    "workflow_list_runs",
    "workflow_signal",
  ],
  "@workbench/tools-x/x": ["x_search"],
  "@workbench/tools-youtube/youtube": ["youtube_search"],
};

const FACTORY_ID_BY_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(PACKAGE_TOOLS).flatMap(([factoryId, names]) =>
    names.map((name) => [name, factoryId]),
  ),
);

// The credential provider each tool package's factory declares
// (`defineCredentialedToolPackage({ provider })`). Keyed by pin name (the
// `@scope/package` an agent pins, i.e. the factory id without its tool
// segment). Packages absent here are keyless or hub-backed (agents, artifact,
// dispatch, hackernews, polymarket, last30days) and need no tenant credential.
// Keep in sync with each package's `interchange-tools.ts` provider.
const PACKAGE_PROVIDERS: Record<string, string> = {
  "@workbench/tools-attio": "attio",
  "@workbench/tools-bluesky": "bluesky",
  "@workbench/tools-exa": "exa",
  "@workbench/tools-firecrawl": "firecrawl",
  "@workbench/tools-gamma": "gamma",
  "@workbench/tools-linear": "linear",
  "@workbench/tools-notion": "notion",
  "@workbench/tools-vercel": "vercel",
  "@workbench/tools-github": "github",
  "@workbench/tools-granola": "granola",
  "@workbench/tools-reddit": "scrapecreators",
  "@workbench/tools-scrapecreators": "scrapecreators",
  "@workbench/tools-x": "xai",
  "@workbench/tools-youtube": "youtube",
};

// The distinct credential providers a set of pinned tool packages requires.
// The hub credential gate authorizes a deployed agent (or workflow step) for
// exactly these providers — derived from its persisted pins, not a tool-name
// registry. Keyless/hub-backed packages contribute nothing.
export function providersForToolPackages(
  pins: readonly ToolPackagePin[],
): string[] {
  const providers = new Set<string>();
  for (const pin of pins) {
    const provider = PACKAGE_PROVIDERS[pin.name];
    if (provider !== undefined) providers.add(provider);
  }
  return [...providers];
}

/**
 * Every LLM-facing tool name a known tool package can produce, via the same
 * `<factoryId>:<name>` → `toLlmToolName` transform the sidecar applies to a
 * loaded package's tool definitions. The dynamic-tools catalog must name only
 * tools in this set: the credential-gate filter matches a catalog entry against
 * the loaded tool names, so a catalog name no factory can produce would be
 * silently hidden forever. Pin the catalog against this set in a test.
 */
export function producibleLlmToolNames(): Set<string> {
  const names = new Set<string>();
  for (const [factoryId, tools] of Object.entries(PACKAGE_TOOLS)) {
    for (const tool of tools) names.add(toLlmToolName(`${factoryId}:${tool}`));
  }
  return names;
}

/**
 * Map raw tool-definition names to the canonical runtime names the sidecar
 * loader emits (`<factoryId>:<name>`). Names belonging to a known tool package
 * are prefixed; everything else (local runners) is returned unchanged.
 */
export function canonicalizeToolNames(names: readonly string[]): string[] {
  return names.map((name) => {
    const factoryId = FACTORY_ID_BY_TOOL[name];
    return factoryId === undefined ? name : `${factoryId}:${name}`;
  });
}

/**
 * Map a canonical runtime tool name (`<factoryId>:<tool>`) to an LLM-safe
 * function name. Provider function names must match `[a-zA-Z0-9_-]` (≤64); the
 * canonical name's `@`, `/`, and especially `:` do not round-trip (kimi-k2.6
 * returns only the part before the `:`, so the call never matches its grant or
 * the loader's dispatch entry — CL-2306). Emits `<pkgShort>__<tool>`, dropping a
 * redundant `<pkgShort>_` prefix on the tool name
 * (`@workbench/tools-exa/exa:exa_search` → `exa__search`). Bare local names (no
 * `:`, e.g. `read_file`) are already safe and pass through unchanged.
 *
 * The hub keys tool grants on this name and the sidecar presents it to the
 * model; the canonical `:` name survives only inside the sidecar's dispatch map
 * and pin derivation, neither of which crosses the model boundary.
 */
export function toLlmToolName(name: string): string {
  const colon = name.lastIndexOf(":");
  if (colon === -1) return name;
  const factoryId = name.slice(0, colon);
  const tool = name.slice(colon + 1);
  const pkgShort = factoryId.slice(factoryId.lastIndexOf("/") + 1);
  const short = tool.startsWith(`${pkgShort}_`)
    ? tool.slice(pkgShort.length + 1)
    : tool;
  return `${pkgShort}__${short}`;
}

function factoryIdFromCanonicalOrBare(name: string): string | undefined {
  const colon = name.lastIndexOf(":");
  if (colon === -1) return FACTORY_ID_BY_TOOL[name];
  return name.slice(0, colon);
}

const EXA_FACTORY_ID = "@workbench/tools-exa/exa";

/**
 * Exa registers `exa_search` and `web_search` as the same capability; the model
 * often calls the generic `web_search` name while capabilities list only
 * `exa_search`. Grant both runtime names when either is authorized.
 */
export function expandToolAliasGrants(
  canonicalNames: readonly string[],
): string[] {
  const out = new Set(canonicalNames);
  const hasExa = canonicalNames.some(
    (n) => factoryIdFromCanonicalOrBare(n) === EXA_FACTORY_ID,
  );
  if (!hasExa) return [...out];
  for (const bare of PACKAGE_TOOLS[EXA_FACTORY_ID] ?? []) {
    out.add(`${EXA_FACTORY_ID}:${bare}`);
  }
  return [...out];
}

// Resolve the npm tool packages that back a set of capability names (bare or
// canonical `<factoryId>:<name>`). A capability with no known package (a local
// runner) contributes nothing. Used to derive a deploy's toolPackagePins from
// the tools its workflow steps declare, so the sidecar loader materializes them.
export function toolPackagesForCapabilities(
  capabilities: readonly string[],
): ToolPackagePin[] {
  const packages = new Set<string>();
  for (const cap of capabilities) {
    const factoryId = cap.includes(":")
      ? cap.slice(0, cap.lastIndexOf(":"))
      : FACTORY_ID_BY_TOOL[cap];
    if (factoryId === undefined) continue;
    packages.add(factoryId.split("/").slice(0, 2).join("/"));
  }
  return [...packages].sort().map((name) => ({ name, version: "^0.1.0" }));
}
