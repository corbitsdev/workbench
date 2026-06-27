import { type } from "arktype";
import { toHumanLabel } from "@workbench/ui";
import type { ToolSummaryStyle } from "@workbench/ui";
import type { ToolCall } from "@workbench/chat/types";

// `ToolSummaryStyle` is owned by @workbench/ui (the foundation both this package
// and the preference hook depend on); re-exported here so callers can keep
// importing it from @workbench/agents.
export type { ToolSummaryStyle };

/**
 * Maps a tool operation to a friendly present-participle action phrase shown in
 * the chat tool narrative, instead of the raw fully-qualified tool name.
 *
 * A phrase may be a plain string or a function that interpolates a meaningful
 * argument (a query / url / name). The interpolator receives the call arguments
 * and returns `null` to fall back to the static phrase when no useful arg is
 * present.
 */
type FriendlyPhrase =
  | string
  | ((args: Record<string, unknown>) => string | null);

function firstStringArg(
  args: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

const QUERY_KEYS = ["query", "q", "search", "term", "keyword"];

function searching(label: string, keys: string[] = QUERY_KEYS): FriendlyPhrase {
  return (args) => {
    const term = firstStringArg(args, keys);
    return term === null
      ? `Searching ${label}`
      : `Searching ${label} for ${term}`;
  };
}

// Keyed by the operation key — the substring after the last `:` in the
// fully-qualified tool name (e.g. `granola_get_note`).
const PHRASES: Record<string, FriendlyPhrase> = {
  // Granola — meeting notes / transcripts
  granola_get_note: "Loading a transcript",
  granola_list_notes: "Finding recent meetings",
  granola_list_folders: "Browsing meeting folders",

  // Exa / generic web search
  exa_search: searching("the web"),
  web_search: searching("the web"),

  // Linear
  linear_list_issues: "Looking through Linear issues",
  linear_get_issue: "Opening a Linear issue",
  linear_list_teams: "Listing Linear teams",
  linear_list_users: "Listing Linear users",

  // Attio CRM
  attio_query_records: "Searching the CRM",
  attio_search_records: "Searching the CRM",
  attio_get_record: "Looking up a CRM record",
  attio_list_objects: "Browsing CRM objects",
  attio_list_workspace_members: "Listing workspace members",

  // Firecrawl — web scraping / crawling
  firecrawl_scrape: (args) => {
    const url = firstStringArg(args, ["url"]);
    return url === null ? "Reading a web page" : `Reading ${url}`;
  },
  firecrawl_search: searching("the web"),
  firecrawl_map: "Mapping a website",
  firecrawl_crawl_start: "Crawling a website",
  firecrawl_crawl_status: "Checking crawl progress",
  firecrawl_crawl_active: "Checking active crawls",
  firecrawl_crawl_cancel: "Cancelling a crawl",
  firecrawl_crawl_errors: "Reviewing crawl errors",
  firecrawl_crawl_params_preview: "Previewing crawl settings",
  firecrawl_batch_scrape_start: "Scraping pages in bulk",
  firecrawl_batch_scrape_status: "Checking bulk scrape progress",
  firecrawl_batch_scrape_errors: "Reviewing bulk scrape errors",
  firecrawl_batch_scrape_cancel: "Cancelling a bulk scrape",
  firecrawl_extract_start: "Extracting page data",
  firecrawl_extract_status: "Checking extraction progress",
  firecrawl_parse: "Parsing a document",
  firecrawl_interact: "Interacting with a page",
  firecrawl_agent: "Researching the web",
  firecrawl_activity: "Checking Firecrawl activity",
  firecrawl_credit_usage: "Checking Firecrawl credits",
  firecrawl_historical_credit_usage: "Reviewing Firecrawl credit history",
  firecrawl_token_usage: "Checking Firecrawl token usage",
  firecrawl_historical_token_usage: "Reviewing Firecrawl token history",
  firecrawl_browser_sessions_list: "Listing browser sessions",
  firecrawl_browser_session_delete: "Closing a browser session",
  firecrawl_monitor_create: "Setting up a page monitor",
  firecrawl_monitor_update: "Updating a page monitor",
  firecrawl_monitor_delete: "Removing a page monitor",
  firecrawl_monitor_get: "Checking a page monitor",
  firecrawl_monitor_list: "Listing page monitors",
  firecrawl_monitor_run: "Running a page monitor",
  firecrawl_monitor_check: "Checking a page monitor",

  // Gamma — presentations
  gamma_create_from_template: "Building a presentation",
  gamma_duplicate_presentation: "Duplicating a presentation",
  gamma_list_templates: "Browsing presentation templates",
  gamma_list_themes: "Browsing presentation themes",

  // GitHub
  github_activity: "Checking GitHub activity",

  // Reddit
  reddit_search: searching("Reddit"),
  reddit_subreddit_search: searching("a subreddit"),

  // X / Twitter
  x_search: searching("X"),

  // YouTube
  youtube_search: searching("YouTube"),

  // Hacker News
  hackernews_search: searching("Hacker News"),

  // Bluesky
  bluesky_search: searching("Bluesky"),

  // Polymarket
  polymarket_odds: "Checking prediction-market odds",

  // ScrapeCreators — social media profiles
  scrapecreators_tiktok: "Pulling TikTok data",
  scrapecreators_instagram: "Pulling Instagram data",
  scrapecreators_threads: "Pulling Threads data",
  scrapecreators_pinterest: "Pulling Pinterest data",

  // Artifact — workspace deliverables
  artifact_create: "Creating an artifact",
  artifact_write: "Saving an artifact",
  artifact_read: "Reading an artifact",
  artifact_list: "Listing artifacts",
  artifact_find_by_title: "Finding an artifact",
  artifact_link_file: "Linking a file",
  artifact_link_presentation: "Linking a presentation",

  // Memory — durable per-user store (CL-2413)
  memory_load: "Recalling memory",
  memory_save: "Updating memory",

  // Dispatch — delegating to other agents
  dispatch_agent: "Delegating to another agent",

  // Agents directory
  list_agents: "Listing available agents",
  list_principals: "Listing workspace members",

  // Per-tool account identity (CL-2420)
  identity_get: "Looking up account identity",
  identity_set: "Saving account identity",

  // last30days research
  last30days_core_extract: "Extracting research findings",
  last30days_core_report: "Compiling a research report",
  last30days_validate: "Validating research sources",
};

/**
 * Parse the operation key out of a fully-qualified tool name. Interchange names
 * look like `@workbench/tools-granola/granola:granola_get_note`; the operation
 * is the substring after the last `:`. Falls back to the whole name when the
 * format differs.
 */
export function toolOperationKey(name: string): string {
  const colon = name.lastIndexOf(":");
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
  if (typeof phrase === "string") return phrase;
  const interpolated = phrase(call.arguments ?? {});
  return interpolated ?? toHumanLabel(key);
}

// A tool's "family" is the prefix before the first underscore of its operation
// key — `attio_get_record` and `attio_query_records` both belong to `attio`.
// This is what lets a turn's many calls roll up into one clause per provider.
function toolFamilyKey(name: string): string {
  const op = toolOperationKey(name);
  const underscore = op.indexOf("_");
  return underscore === -1 ? op : op.slice(0, underscore);
}

/**
 * How the roll-up sentence reads. All styles are deterministic — a given turn
 * always renders the same way.
 * - `symbols` — compact counts: "Searched Attio 6×, read 5 notes, checked Linear 2×"
 * - `natural` — spelled counts: "Searched Attio 6 times, read 5 notes, checked Linear twice"
 * - `detail`  — natural + a light detail from results: "found 2 Linear issues (one high-priority)"
 * - `varied`  — rotated verbs per family: "Combed Attio 6 times, skimmed 5 notes…"
 * - `mixed`   — varied verbs + natural counts + detail
 */
export const TOOL_SUMMARY_STYLES: readonly ToolSummaryStyle[] = [
  "symbols",
  "natural",
  "detail",
  "varied",
  "mixed",
];

export const TOOL_SUMMARY_STYLE_LABELS: Readonly<
  Record<ToolSummaryStyle, string>
> = {
  symbols: "Symbols (6×)",
  natural: "Natural counts (twice)",
  detail: "Natural + detail",
  varied: "Varied verbs",
  mixed: "Mix everything",
};

const STYLE_SET = new Set<string>(TOOL_SUMMARY_STYLES);

export function isToolSummaryStyle(value: unknown): value is ToolSummaryStyle {
  return typeof value === "string" && STYLE_SET.has(value);
}

function usesAltVerb(style: ToolSummaryStyle): boolean {
  return style === "varied" || style === "mixed";
}

function usesDetail(style: ToolSummaryStyle): boolean {
  return style === "detail" || style === "mixed";
}

// The count suffix for a verb-only family. Omitted for a single call so one
// Attio lookup reads "searched Attio", not "searched Attio 1×".
function countSuffix(count: number, style: ToolSummaryStyle): string {
  if (count <= 1) return "";
  if (style === "symbols") return ` ${count}×`;
  if (count === 2) return " twice";
  return ` ${count} times`;
}

interface FamilyDef {
  // Past-tense verb phrase for a verb-only family ("searched Attio"), or the
  // action for a counted-noun family ("read").
  verb: string;
  // Alternate verb used by the `varied`/`mixed` styles.
  altVerb?: string;
  // Present for families whose calls count discrete objects ("5 notes").
  noun?: { one: string; many: string };
  // Best-effort richer clause built from the calls' results, used by the
  // `detail`/`mixed` styles. Returns null to fall back to the plain clause.
  detail?: (calls: ToolCall[]) => string | null;
}

function pluralize(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

// The slice of a Linear tool result we read for the `detail` styles. A result
// is either a bare issue array or a `{ issues: [...] }` envelope; each issue may
// carry a priority as a number (the 0-4 scale), a name string, or a `{ name }`
// object whose name is a string label. Numeric priorities only appear at the top
// level; a nested `{ name }` is always a human label, so it is typed as a string.
// Extra fields are allowed. Validated through arktype rather than guessed so an
// upstream shape change degrades cleanly to the plain clause instead of mis-parsing.
const LinearPriority = type("number | string").or({ "name?": "string" });
const LinearIssue = type({
  "[string]": "unknown",
  "priority?": LinearPriority,
});
const LinearIssues = LinearIssue.array();
const LinearResult = LinearIssues.or({ issues: LinearIssues });

// Numeric priorities are high only at the top level (Linear's 1 = Urgent, 2 = High);
// a nested `{ name }` carries the human label, where high means 'Urgent' or 'High'.
function isHighPriority(
  priority: typeof LinearPriority.infer | undefined,
): boolean {
  if (typeof priority === "number") return priority === 1 || priority === 2;
  const name =
    typeof priority === "object" && priority !== null
      ? priority.name
      : priority;
  return name === "Urgent" || name === "High";
}

// Detects how many issues a Linear turn pulled and whether any are high-stakes,
// degrading to null when a result does not match the expected shape.
function linearDetail(calls: ToolCall[]): string | null {
  let issues = 0;
  let high = 0;
  for (const call of calls) {
    if (call.result === undefined || call.result === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.result);
    } catch {
      continue;
    }
    const validated = LinearResult(parsed);
    if (validated instanceof type.errors) continue;
    const list = Array.isArray(validated) ? validated : validated.issues;
    for (const item of list) {
      issues += 1;
      if (isHighPriority(item.priority)) high += 1;
    }
  }
  if (issues === 0) return null;
  const noun = pluralize(issues, "Linear issue", "Linear issues");
  if (high === 1) return `found ${issues} ${noun} (one high-priority)`;
  if (high > 1) return `found ${issues} ${noun} (${high} high-priority)`;
  return `found ${issues} ${noun}`;
}

const FAMILY_DEFS: Record<string, FamilyDef> = {
  granola: {
    verb: "read",
    altVerb: "skimmed",
    noun: { one: "note", many: "notes" },
  },
  firecrawl: {
    verb: "read",
    altVerb: "pulled",
    noun: { one: "web page", many: "web pages" },
  },
  artifact: {
    verb: "updated",
    altVerb: "touched",
    noun: { one: "artifact", many: "artifacts" },
  },
  exa: { verb: "searched the web", altVerb: "scoured the web" },
  web: { verb: "searched the web", altVerb: "scoured the web" },
  attio: { verb: "searched Attio", altVerb: "combed Attio" },
  linear: {
    verb: "checked Linear",
    altVerb: "dug through Linear",
    detail: linearDetail,
  },
  github: { verb: "checked GitHub", altVerb: "browsed GitHub" },
  reddit: { verb: "searched Reddit", altVerb: "scoured Reddit" },
  x: { verb: "searched X", altVerb: "scanned X" },
  youtube: { verb: "searched YouTube", altVerb: "scanned YouTube" },
  hackernews: { verb: "searched Hacker News", altVerb: "scanned Hacker News" },
  bluesky: { verb: "searched Bluesky", altVerb: "scanned Bluesky" },
  polymarket: {
    verb: "checked prediction markets",
    altVerb: "eyed prediction markets",
  },
  scrapecreators: {
    verb: "pulled social data",
    altVerb: "gathered social data",
  },
  gamma: { verb: "worked on a presentation", altVerb: "built a presentation" },
  dispatch: {
    verb: "delegated to another agent",
    altVerb: "handed off to another agent",
  },
  last30days: { verb: "researched", altVerb: "dug into the research" },
};

function familyClause(
  family: string,
  calls: ToolCall[],
  count: number,
  style: ToolSummaryStyle,
): string {
  const def = FAMILY_DEFS[family];
  if (def === undefined) {
    return `${toHumanLabel(family).toLowerCase()}${countSuffix(count, style)}`;
  }
  if (usesDetail(style) && def.detail !== undefined) {
    const detail = def.detail(calls);
    if (detail !== null) return detail;
  }
  const verb =
    usesAltVerb(style) && def.altVerb !== undefined ? def.altVerb : def.verb;
  if (def.noun !== undefined) {
    return `${verb} ${count} ${pluralize(count, def.noun.one, def.noun.many)}`;
  }
  return `${verb}${countSuffix(count, style)}`;
}

function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses.join("");
  if (clauses.length === 2) return clauses.join(" and ");
  const last = clauses[clauses.length - 1];
  return `${clauses.slice(0, -1).join(", ")}, and ${last}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Rolls a turn's tool calls up into a single human-readable summary line,
 * grouped by provider family and counted, e.g.
 * "Searched Attio 6×, read 5 notes, and checked Linear 2×".
 *
 * Families are ordered by first appearance so the sentence mirrors what the
 * agent actually did. The `style` selects the phrasing. Returns an empty string
 * for no calls.
 */
export function summarizeToolCalls(
  calls: ToolCall[],
  style: ToolSummaryStyle = "symbols",
): string {
  if (calls.length === 0) return "";
  const order: string[] = [];
  const byFamily = new Map<string, ToolCall[]>();
  for (const call of calls) {
    const family = toolFamilyKey(call.name);
    const existing = byFamily.get(family);
    if (existing === undefined) {
      order.push(family);
      byFamily.set(family, [call]);
    } else {
      existing.push(call);
    }
  }
  const clauses = order.map((family) => {
    const familyCalls = byFamily.get(family) ?? [];
    return familyClause(family, familyCalls, familyCalls.length, style);
  });
  return capitalize(joinClauses(clauses));
}

// A representative turn used to render a live example of each style in Settings,
// so the preview always matches real output (including detail extraction). The
// Linear result is shaped so the `detail`/`mixed` styles surface the priority.
export const TOOL_SUMMARY_PREVIEW_CALLS: ToolCall[] = [
  {
    id: "p1",
    name: "@workbench/tools-attio/attio:attio_search_records",
    result: "ok",
  },
  {
    id: "p2",
    name: "@workbench/tools-attio/attio:attio_get_record",
    result: "ok",
  },
  {
    id: "p3",
    name: "@workbench/tools-attio/attio:attio_get_record",
    result: "ok",
  },
  {
    id: "p4",
    name: "@workbench/tools-attio/attio:attio_get_record",
    result: "ok",
  },
  {
    id: "p5",
    name: "@workbench/tools-attio/attio:attio_get_record",
    result: "ok",
  },
  {
    id: "p6",
    name: "@workbench/tools-attio/attio:attio_query_records",
    result: "ok",
  },
  {
    id: "p7",
    name: "@workbench/tools-granola/granola:granola_list_notes",
    result: "ok",
  },
  {
    id: "p8",
    name: "@workbench/tools-granola/granola:granola_get_note",
    result: "ok",
  },
  {
    id: "p9",
    name: "@workbench/tools-granola/granola:granola_get_note",
    result: "ok",
  },
  {
    id: "p10",
    name: "@workbench/tools-granola/granola:granola_get_note",
    result: "ok",
  },
  {
    id: "p11",
    name: "@workbench/tools-granola/granola:granola_get_note",
    result: "ok",
  },
  {
    id: "p12",
    name: "@workbench/tools-linear/linear:linear_list_issues",
    result: JSON.stringify([
      { id: "CL-1", priority: "High" },
      { id: "CL-2", priority: "Medium" },
    ]),
  },
];
