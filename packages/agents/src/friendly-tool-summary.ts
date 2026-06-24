import { toHumanLabel } from '@workbench/ui';
import type { ToolCall } from '@workbench/chat';

/**
 * Maps a tool operation to a friendly present-participle action phrase shown in
 * the chat tool narrative, instead of the raw fully-qualified tool name.
 *
 * A phrase may be a plain string or a function that interpolates a meaningful
 * argument (a query / url / name). The interpolator receives the call arguments
 * and returns `null` to fall back to the static phrase when no useful arg is
 * present.
 */
type FriendlyPhrase = string | ((args: Record<string, unknown>) => string | null);

function firstStringArg(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

const QUERY_KEYS = ['query', 'q', 'search', 'term', 'keyword'];

function searching(label: string, keys: string[] = QUERY_KEYS): FriendlyPhrase {
  return (args) => {
    const term = firstStringArg(args, keys);
    return term === null ? `Searching ${label}` : `Searching ${label} for ${term}`;
  };
}

// Keyed by the operation key — the substring after the last `:` in the
// fully-qualified tool name (e.g. `granola_get_note`).
const PHRASES: Record<string, FriendlyPhrase> = {
  // Granola — meeting notes / transcripts
  granola_get_note: 'Loading a transcript',
  granola_list_notes: 'Finding recent meetings',
  granola_list_folders: 'Browsing meeting folders',

  // Exa / generic web search
  exa_search: searching('the web'),
  web_search: searching('the web'),

  // Linear
  linear_list_issues: 'Looking through Linear issues',
  linear_get_issue: 'Opening a Linear issue',
  linear_list_teams: 'Listing Linear teams',
  linear_list_users: 'Listing Linear users',

  // Attio CRM
  attio_query_records: 'Searching the CRM',
  attio_search_records: 'Searching the CRM',
  attio_get_record: 'Looking up a CRM record',
  attio_list_objects: 'Browsing CRM objects',
  attio_list_workspace_members: 'Listing workspace members',

  // Firecrawl — web scraping / crawling
  firecrawl_scrape: (args) => {
    const url = firstStringArg(args, ['url']);
    return url === null ? 'Reading a web page' : `Reading ${url}`;
  },
  firecrawl_search: searching('the web'),
  firecrawl_map: 'Mapping a website',
  firecrawl_crawl_start: 'Crawling a website',
  firecrawl_crawl_status: 'Checking crawl progress',
  firecrawl_crawl_active: 'Checking active crawls',
  firecrawl_crawl_cancel: 'Cancelling a crawl',
  firecrawl_crawl_errors: 'Reviewing crawl errors',
  firecrawl_crawl_params_preview: 'Previewing crawl settings',
  firecrawl_batch_scrape_start: 'Scraping pages in bulk',
  firecrawl_batch_scrape_status: 'Checking bulk scrape progress',
  firecrawl_batch_scrape_errors: 'Reviewing bulk scrape errors',
  firecrawl_batch_scrape_cancel: 'Cancelling a bulk scrape',
  firecrawl_extract_start: 'Extracting page data',
  firecrawl_extract_status: 'Checking extraction progress',
  firecrawl_parse: 'Parsing a document',
  firecrawl_interact: 'Interacting with a page',
  firecrawl_agent: 'Researching the web',
  firecrawl_activity: 'Checking Firecrawl activity',
  firecrawl_credit_usage: 'Checking Firecrawl credits',
  firecrawl_historical_credit_usage: 'Reviewing Firecrawl credit history',
  firecrawl_token_usage: 'Checking Firecrawl token usage',
  firecrawl_historical_token_usage: 'Reviewing Firecrawl token history',
  firecrawl_browser_sessions_list: 'Listing browser sessions',
  firecrawl_browser_session_delete: 'Closing a browser session',
  firecrawl_monitor_create: 'Setting up a page monitor',
  firecrawl_monitor_update: 'Updating a page monitor',
  firecrawl_monitor_delete: 'Removing a page monitor',
  firecrawl_monitor_get: 'Checking a page monitor',
  firecrawl_monitor_list: 'Listing page monitors',
  firecrawl_monitor_run: 'Running a page monitor',
  firecrawl_monitor_check: 'Checking a page monitor',

  // Gamma — presentations
  gamma_create_from_template: 'Building a presentation',
  gamma_duplicate_presentation: 'Duplicating a presentation',
  gamma_list_templates: 'Browsing presentation templates',
  gamma_list_themes: 'Browsing presentation themes',

  // GitHub
  github_activity: 'Checking GitHub activity',

  // Reddit
  reddit_search: searching('Reddit'),
  reddit_subreddit_search: searching('a subreddit'),

  // X / Twitter
  x_search: searching('X'),

  // YouTube
  youtube_search: searching('YouTube'),

  // Hacker News
  hackernews_search: searching('Hacker News'),

  // Bluesky
  bluesky_search: searching('Bluesky'),

  // Polymarket
  polymarket_odds: 'Checking prediction-market odds',

  // ScrapeCreators — social media profiles
  scrapecreators_tiktok: 'Pulling TikTok data',
  scrapecreators_instagram: 'Pulling Instagram data',
  scrapecreators_threads: 'Pulling Threads data',
  scrapecreators_pinterest: 'Pulling Pinterest data',

  // Artifact — workspace deliverables
  artifact_create: 'Creating an artifact',
  artifact_write: 'Saving an artifact',
  artifact_read: 'Reading an artifact',
  artifact_list: 'Listing artifacts',
  artifact_find_by_title: 'Finding an artifact',
  artifact_link_file: 'Linking a file',
  artifact_link_presentation: 'Linking a presentation',

  // Dispatch — delegating to other agents
  dispatch_agent: 'Delegating to another agent',

  // Agents directory
  list_agents: 'Listing available agents',
  list_principals: 'Listing workspace members',

  // last30days research
  last30days_core_extract: 'Extracting research findings',
  last30days_core_report: 'Compiling a research report',
  last30days_validate: 'Validating research sources',
};

/**
 * Parse the operation key out of a fully-qualified tool name. Interchange names
 * look like `@workbench/tools-granola/granola:granola_get_note`; the operation
 * is the substring after the last `:`. Falls back to the whole name when the
 * format differs.
 */
export function toolOperationKey(name: string): string {
  const colon = name.lastIndexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * A host `formatToolSummary`: renders a friendly action verb for a tool call.
 * Unknown operations fall back to `toHumanLabel` so nothing regresses.
 */
export function friendlyToolSummary(call: ToolCall): string {
  const key = toolOperationKey(call.name);
  const phrase = PHRASES[key];
  if (phrase === undefined) return toHumanLabel(key);
  if (typeof phrase === 'string') return phrase;
  const interpolated = phrase(call.arguments ?? {});
  return interpolated ?? toHumanLabel(key);
}
