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
  '@workbench/tools-agents/agents': ['list_agents', 'list_principals'],
  '@workbench/tools-artifact/artifact': [
    'artifact_create',
    'artifact_read',
    'artifact_write',
    'artifact_list',
    'artifact_find_by_title',
    'artifact_link_file',
    'artifact_link_presentation',
    'write_artifact',
  ],
  '@workbench/tools-bluesky/bluesky': ['bluesky_search'],
  '@workbench/tools-dispatch/dispatch': ['dispatch_agent'],
  '@workbench/tools-exa/exa': ['exa_search', 'web_search'],
  '@workbench/tools-firecrawl/firecrawl': [
    'firecrawl_scrape',
    'firecrawl_search',
    'firecrawl_map',
    'firecrawl_crawl_start',
    'firecrawl_crawl_status',
    'firecrawl_batch_scrape_start',
    'firecrawl_batch_scrape_status',
    'firecrawl_extract_start',
    'firecrawl_extract_status',
    'firecrawl_agent',
    'firecrawl_parse',
    'firecrawl_credit_usage',
    'firecrawl_token_usage',
  ],
  '@workbench/tools-gamma/gamma': [
    'gamma_create_from_template',
    'gamma_duplicate_presentation',
    'gamma_list_templates',
    'gamma_list_themes',
  ],
  '@workbench/tools-github/github': ['github_activity'],
  '@workbench/tools-granola/granola': [
    'granola_list_notes',
    'granola_get_note',
    'granola_list_folders',
  ],
  '@workbench/tools-hackernews/hackernews': ['hackernews_search'],
  '@workbench/tools-last30days/core': [
    'last30days_core_extract',
    'last30days_core_report',
    'last30days_validate',
  ],
  '@workbench/tools-polymarket/polymarket': ['polymarket_odds'],
  '@workbench/tools-reddit/reddit': ['reddit_search', 'reddit_subreddit_search'],
  '@workbench/tools-scrapecreators/scrapecreators': [
    'scrapecreators_tiktok',
    'scrapecreators_instagram',
    'scrapecreators_threads',
    'scrapecreators_pinterest',
  ],
  '@workbench/tools-x/x': ['x_search'],
  '@workbench/tools-youtube/youtube': ['youtube_search'],
};

const FACTORY_ID_BY_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(PACKAGE_TOOLS).flatMap(([factoryId, names]) =>
    names.map((name) => [name, factoryId])
  )
);

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
