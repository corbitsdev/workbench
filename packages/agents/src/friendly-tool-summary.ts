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
  | ((args: Record<string, unknown>, call?: ToolCall) => string | null);

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

/** Deterministic pick so the same call always renders the same polished phrase. */
function pickPhrase(seed: string, options: readonly string[]): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return options[h % options.length] ?? options[0] ?? "";
}

function searching(label: string, keys: string[] = QUERY_KEYS): FriendlyPhrase {
  return (args) => {
    const term = firstStringArg(args, keys);
    return term === null
      ? `Searching ${label}`
      : `Searching ${label} for ${term}`;
  };
}

// Platform catalog meta-tools are internal plumbing, not user-facing capabilities.
// The chat UI renders them as quiet reasoning-style lines (see isCatalogMetaTool).
const SEARCH_TOOLS_IDLE = [
  "Searching Workbench…",
  "Exploring the best tools for you",
  "Finding the right capability",
  "Looking across Workbench…",
] as const;

const SEARCH_TOOLS_WITH_TERM = (term: string) =>
  [
    `Looking for tools about ${term}`,
    `Exploring tools for ${term}`,
    `Searching Workbench for ${term}`,
  ] as const;

const LOAD_TOOLS_IDLE = [
  "Getting that ready",
  "Bringing tools online",
  "Preparing what I need",
] as const;

const LOAD_TOOLS_PKG = (pkg: string) =>
  [
    `Loading ${pkg} for you`,
    `Bringing ${pkg} online`,
    `Getting ${pkg} ready`,
  ] as const;

/** Pull a human name out of Attio-style `values` (plain string or nested write form). */
function attioRecordName(values: unknown): string | null {
  if (values === null || values === undefined || typeof values !== "object") {
    return null;
  }
  const record = values as Record<string, unknown>;
  for (const key of ["name", "full_name", "title"]) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
    if (Array.isArray(raw) && raw.length > 0) {
      const first = raw[0];
      if (typeof first === "string" && first.trim() !== "") return first.trim();
      if (
        first !== null &&
        typeof first === "object" &&
        typeof (first as { value?: unknown }).value === "string"
      ) {
        const v = ((first as { value: string }).value ?? "").trim();
        if (v !== "") return v;
      }
    }
  }
  return null;
}

function truncate(text: string, max = 48): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

const PHRASES: Record<string, FriendlyPhrase> = {
  // Platform meta-tools (catalog runner locals) — polished, rotated, quiet.
  search_tools: (args, call) => {
    const term = firstStringArg(args, QUERY_KEYS);
    const seed = `${call?.id ?? ""}|${term ?? ""}`;
    if (term !== null) {
      return pickPhrase(seed, SEARCH_TOOLS_WITH_TERM(truncate(term)));
    }
    return pickPhrase(seed || "search_tools", SEARCH_TOOLS_IDLE);
  },
  load_tools: (args, call) => {
    const pkg = firstStringArg(args, ["package"]);
    const names = args.names;
    const seed = `${call?.id ?? ""}|${pkg ?? ""}|${
      Array.isArray(names) ? names.length : 0
    }`;
    if (pkg !== null) {
      return pickPhrase(seed, LOAD_TOOLS_PKG(pkg));
    }
    if (Array.isArray(names) && names.length > 0) {
      if (names.length === 1) {
        return pickPhrase(seed, [
          "Getting that ready",
          "Bringing a tool online",
          "Preparing a tool",
        ]);
      }
      return pickPhrase(seed, [
        `Getting ${names.length} tools ready`,
        `Bringing ${names.length} tools online`,
        `Preparing ${names.length} tools`,
      ]);
    }
    return pickPhrase(seed || "load_tools", LOAD_TOOLS_IDLE);
  },

  // Granola — meeting notes / transcripts
  granola_get_note: "Loading a transcript",
  granola_list_notes: "Finding recent meetings",
  granola_list_folders: "Browsing meeting folders",

  // Exa / generic web search
  exa_search: searching("the web"),
  web_search: searching("the web"),

  // Linear
  linear_list_issues: "Looking through Linear issues",
  linear_get_issue: (args) => {
    const id = firstStringArg(args, ["id", "issueId", "identifier"]);
    return id === null
      ? "Opening a Linear issue"
      : `Opening Linear issue ${id}`;
  },
  linear_list_teams: "Listing Linear teams",
  linear_list_users: "Listing Linear users",

  // Attio CRM — brand name in the phrase (not "CRM") so the UI reads naturally
  attio_query_records: (args) => {
    const term = firstStringArg(args, [
      "nameContains",
      "domainContains",
      ...QUERY_KEYS,
    ]);
    const object = firstStringArg(args, ["object"]);
    if (term !== null && object !== null) {
      return `Searching Attio ${object} for ${truncate(term)}`;
    }
    if (term !== null) return `Searching Attio for ${truncate(term)}`;
    if (object !== null) return `Searching Attio ${object}`;
    return "Searching Attio";
  },
  attio_search_records: (args) => {
    const term = firstStringArg(args, QUERY_KEYS);
    return term === null
      ? "Searching Attio"
      : `Searching Attio for ${truncate(term)}`;
  },
  attio_get_record: (args) => {
    const object = firstStringArg(args, ["object"]);
    return object === null
      ? "Looking up an Attio record"
      : `Looking up an Attio ${object} record`;
  },
  attio_list_objects: "Browsing Attio objects",
  attio_list_workspace_members: "Listing Attio workspace members",
  attio_list_tasks: "Listing Attio tasks",
  attio_get_task: "Looking up an Attio task",
  attio_update_task: "Updating an Attio task",
  attio_create_note: "Adding an Attio note",
  attio_create_record: (args) => {
    const name = attioRecordName(args.values);
    const object = firstStringArg(args, ["object"]);
    if (name !== null) return `Creating an Attio record for ${truncate(name)}`;
    if (object !== null) return `Creating an Attio ${object} record`;
    return "Creating an Attio record";
  },

  // Firecrawl — web scraping / crawling
  firecrawl_scrape: (args) => {
    const url = firstStringArg(args, ["url"]);
    return url === null ? "Reading a web page" : `Reading ${truncate(url, 56)}`;
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

  // Workflow runs
  workflow_list_kinds: "Listing runnable workflows",
  workflow_start: (args) => {
    const kind = firstStringArg(args, ["kind"]);
    return kind === null
      ? "Starting a workflow"
      : `Starting the ${kind} workflow`;
  },
  workflow_list_runs: "Checking workflow runs",
  workflow_signal: "Resuming a workflow run",

  // Gamma — presentations
  gamma_create_from_template: "Building a presentation",
  gamma_duplicate_presentation: "Duplicating a presentation",
  gamma_list_templates: "Browsing presentation templates",
  gamma_list_themes: "Browsing presentation themes",

  // GitHub
  github_activity: searching("GitHub"),

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
  write_artifact: "Saving an artifact",
  artifact_read: "Reading an artifact",
  artifact_read_chunk: "Reading an artifact",
  artifact_list: "Listing artifacts",
  artifact_find_by_title: "Finding an artifact",
  artifact_link_file: "Linking a file",
  artifact_link_presentation: "Linking a presentation",
  artifact_link_gamma_presentation: "Linking a presentation",

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

  // Skills
  search_skills: (args) => {
    const term = firstStringArg(args, QUERY_KEYS);
    return term === null
      ? "Searching skills"
      : `Searching skills for ${truncate(term)}`;
  },
  load_skill: (args) => {
    const name = firstStringArg(args, ["name", "skill", "id"]);
    return name === null
      ? "Loading a skill"
      : `Loading skill ${truncate(name)}`;
  },
  list_skills: "Listing skills",
  list_skill_drafts: "Listing skill drafts",
  load_skill_draft: "Loading a skill draft",
  skill_draft: (args) => {
    const name = firstStringArg(args, ["name"]);
    return name === null
      ? "Drafting a skill"
      : `Drafting skill ${truncate(name)}`;
  },

  // Notion
  notion_search: searching("Notion"),
  notion_get_page: "Opening a Notion page",
  notion_get_page_content: "Reading a Notion page",
  notion_get_database: "Opening a Notion database",
  notion_query_database: "Querying a Notion database",
  notion_create_page: (args) => {
    const title = firstStringArg(args, ["title", "name"]);
    return title === null
      ? "Creating a Notion page"
      : `Creating a Notion page for ${truncate(title)}`;
  },

  // Vercel
  vercel_list_projects: "Listing Vercel projects",
  vercel_list_deployments: "Listing Vercel deployments",
  vercel_deploy_static_file: "Deploying a static file",
  vercel_deploy_artifact: "Deploying an artifact",

  // File parser
  parse_file: "Parsing a document",
};

/**
 * The raw operation segment of a tool name (after the last `:` for FQNs).
 * LLM form keeps the double underscore: `attio__create_record`.
 */
function operationSegment(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Phrase-table lookup keys for a tool name, most-specific first.
 *
 * - FQN / bare: `attio_create_record`
 * - LLM with stripped package prefix: `attio__create_record` → `attio_create_record`
 * - LLM without package prefix on the tool: `skills__search_skills` → `search_skills`
 */
function phraseKeyCandidates(name: string): string[] {
  const op = operationSegment(name);
  const out: string[] = [];
  const push = (k: string) => {
    if (k !== "" && !out.includes(k)) out.push(k);
  };
  push(op);
  const dunder = op.indexOf("__");
  if (dunder !== -1) {
    const pkg = op.slice(0, dunder);
    const short = op.slice(dunder + 2);
    push(`${pkg}_${short}`);
    push(short);
  }
  if (op.includes("__")) push(op.split("__").join("_"));
  return out;
}

/**
 * Canonical bare operation key used for roll-up family grouping and fallbacks.
 *
 * - FQN: `@workbench/tools-granola/granola:granola_get_note` → `granola_get_note`
 * - LLM with package-prefixed bare: `attio__create_record` → `attio_create_record`
 * - LLM without: `skills__list_skills` → `list_skills` when that is the bare name
 * - bare: unchanged
 */
export function toolOperationKey(name: string): string {
  const candidates = phraseKeyCandidates(name);
  for (const key of candidates) {
    if (PHRASES[key] !== undefined) return key;
  }
  // Prefer `pkg_short` reconstruction for LLM form; otherwise the first candidate.
  return candidates[0] ?? name;
}

/**
 * Soft sentence-case fallback that never surfaces snake_case or Title Case tool ids.
 * `mystery_do_thing` → "Mystery do thing"
 */
function softFallback(key: string): string {
  const words = key
    .split("__")
    .join("_")
    .split(/[-_]+/u)
    .filter((w: string) => w.length > 0);
  if (words.length === 0) return "Working on a task";
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Platform catalog meta-tools (`search_tools` / `load_tools`). They are internal
 * plumbing, not user-facing capabilities — chat renders them as quiet
 * reasoning-style lines (no tool chrome / checkmark) and excludes them from
 * roll-up tool counts.
 */
export function isCatalogMetaTool(name: string): boolean {
  const key = toolOperationKey(name);
  return key === "search_tools" || key === "load_tools";
}

/**
 * A host `formatToolSummary`: renders a friendly action verb for a tool call.
 * Unknown operations fall back to a soft sentence-case label — never the raw id.
 */
export function friendlyToolSummary(call: ToolCall): string {
  const key = toolOperationKey(call.name);
  const phrase = PHRASES[key];
  if (phrase === undefined) return softFallback(key);
  if (typeof phrase === "string") return phrase;
  const interpolated = phrase(call.arguments ?? {}, call);
  return interpolated ?? softFallback(key);
}

/**
 * Short human outcome for a settled tool call. Returns null when there is nothing
 * useful to say (pending, empty, or unparseable). Never returns raw JSON.
 */
export function friendlyToolResult(call: ToolCall): string | null {
  if (call.isError === true) {
    if (typeof call.result === "string" && call.result.trim() !== "") {
      return truncate(call.result.trim(), 160);
    }
    return "Something went wrong";
  }
  if (call.result === undefined || call.result === "") return null;

  const text = call.result.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Plain text result — show a short snippet, not a wall of text.
    if (text.length <= 120 && !text.startsWith("{") && !text.startsWith("[")) {
      return text;
    }
    return "Done";
  }

  if (Array.isArray(parsed)) {
    const n = parsed.length;
    if (n === 0) return "No results";
    if (n === 1) return "Found 1 result";
    return `Found ${n} results`;
  }

  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;

    // search_tools / catalog-shaped results
    if (Array.isArray(obj.tools)) {
      const n = obj.tools.length;
      if (n === 0) return "No matching tools";
      if (n === 1) return "Found 1 tool";
      return `Found ${n} tools`;
    }
    if (Array.isArray(obj.packages)) {
      const n = obj.packages.length;
      if (n === 0) return "No matching packages";
      return n === 1 ? "Found 1 package" : `Found ${n} packages`;
    }
    if (Array.isArray(obj.results)) {
      const n = obj.results.length;
      if (n === 0) return "No results";
      return n === 1 ? "Found 1 result" : `Found ${n} results`;
    }
    if (Array.isArray(obj.data)) {
      const n = obj.data.length;
      if (n === 0) return "No results";
      return n === 1 ? "Found 1 result" : `Found ${n} results`;
    }
    if (typeof obj.count === "number") {
      return obj.count === 0 ? "No results" : `Found ${obj.count} results`;
    }
    if (obj.deduped === true) return "Already exists — skipped create";
    if (obj.loaded === true || obj.ok === true) return "Done";
    if (typeof obj.id === "string" || typeof obj.record_id === "string") {
      return "Done";
    }
    // Nested Attio record envelope
    if (obj.id !== null && typeof obj.id === "object") return "Done";
  }

  if (typeof parsed === "string") return truncate(parsed, 120);
  if (typeof parsed === "number" || typeof parsed === "boolean") {
    return String(parsed);
  }

  return "Done";
}

// A tool's "family" is the package short name for LLM form (`attio__…` →
// `attio`) or the prefix before the first underscore of a bare key
// (`attio_get_record` → `attio`). This is what lets a turn's many calls roll
// up into one clause per provider.
function toolFamilyKey(name: string): string {
  const op = operationSegment(name);
  const dunder = op.indexOf("__");
  if (dunder !== -1) return op.slice(0, dunder);
  const key = toolOperationKey(name);
  const underscore = key.indexOf("_");
  return underscore === -1 ? key : key.slice(0, underscore);
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
  notion: { verb: "checked Notion", altVerb: "browsed Notion" },
  vercel: { verb: "checked Vercel", altVerb: "browsed Vercel" },
  skills: { verb: "looked up skills", altVerb: "browsed skills" },
  search: { verb: "looked up tools", altVerb: "browsed tools" },
  load: { verb: "loaded tools", altVerb: "pulled in tools" },
  list: { verb: "listed items", altVerb: "browsed items" },
  identity: { verb: "checked identity", altVerb: "looked up identity" },
  memory: { verb: "updated memory", altVerb: "recalled memory" },
  workflow: { verb: "worked with workflows", altVerb: "ran a workflow" },
  parse: { verb: "parsed a document", altVerb: "read a document" },
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
  // Catalog meta-tools are internal plumbing — never count them in the roll-up.
  const real = calls.filter((c) => !isCatalogMetaTool(c.name));
  if (real.length === 0) return "";
  const order: string[] = [];
  const byFamily = new Map<string, ToolCall[]>();
  for (const call of real) {
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
