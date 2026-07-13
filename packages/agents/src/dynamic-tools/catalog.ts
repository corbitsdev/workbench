import type { ToolCatalog, ToolCatalogEntry } from "@workbench/tools-catalog";
import {
  bareToolNamesForPin,
  canonicalizeToolNames,
  toLlmToolName,
} from "../tool-names";
import { friendlyToolSummary } from "../friendly-tool-summary";

/**
 * Myra's turn-1 advertised platform tools, as bare names. `search_tools` and
 * `load_tools` are catalog-runner locals added in the agent definition; the
 * rest come from pinned packages. This is the ONLY tool-name list maintained by
 * hand — everything a pinned package ships beyond these is catalog-managed,
 * derived (never re-listed) so the catalog, grants, and pins cannot drift.
 */
export const MYRA_PLATFORM_BARE_TOOL_NAMES: string[] = [
  "memory_load",
  "memory_save",
  "artifact_create",
  "artifact_read",
  "artifact_write",
  "artifact_list",
  "workflow_list_kinds",
  "workflow_start",
  "search_skills",
  "load_skill",
  "list_skill_drafts",
  "load_skill_draft",
  // Native sidecar-local tool (not from a pinned package — mail_* runners
  // are always mounted by the harness, see tool-names.ts), so it is granted
  // here rather than added as a catalog package. Lets Myra send a note to a
  // teammate's inbox; gated behind human approval (APPROVAL_GATED_TOOL_NAMES)
  // and excluded from the mailbox-triage persona (isMailboxReadOnlyTool).
  "mail_send",
  // Hub-backed native task tool (apps/hub/src/tools/task-tools.ts), not a
  // pinned package. Unlike every other write here, this one IS admitted into
  // the mailbox-triage persona (see `READ_ONLY_EXTRA_TOOLS` in
  // packages/myra/src/personas/mailbox.ts) — leaving a durable, unsent task
  // behind is triage's own prepare-only output, not an irreversible action.
  "task_create",
];

/**
 * The packages Myra pins, with the hand-authored search metadata each needs
 * (summary + tags). Tool NAMES are never listed here — they are derived from
 * the package's real tools (`bareToolNamesForPin`) minus the platform set, so
 * one edit to a package's tool list flows to the catalog, grants, and pins
 * automatically.
 *
 * To give Myra a new integration: add its package here. To keep a capability
 * workflow-only (Gamma, last30days): leave its package out — never pinned,
 * never granted, never advertised.
 */
type CatalogPackage = {
  /** The `@scope/package` pin name (one published tarball). */
  pin: string;
  /** Catalog display key; also the `load_tools({ package })` argument. */
  package: string;
  summary: string;
  tags: string[];
};

const MYRA_CATALOG_PACKAGES: CatalogPackage[] = [
  {
    pin: "@workbench/tools-artifact",
    package: "artifacts",
    summary:
      "Advanced artifact tools — chunked reads, lookup by title, linking.",
    tags: ["artifact", "deliverable", "chunk", "link", "presentation"],
  },
  {
    pin: "@workbench/tools-workflows",
    package: "workflows",
    summary: "Workflow run controls — list runs and signal awaiting gates.",
    tags: ["workflow", "runs", "signal", "gate", "control"],
  },
  {
    pin: "@workbench/tools-skills",
    package: "skills",
    summary:
      "Skills library — list every skill, read and improve your pending drafts, and draft new ones.",
    tags: ["skills", "guidance", "playbooks", "how-to", "capabilities"],
  },
  {
    pin: "@workbench/tools-agents",
    package: "identity",
    summary: "Directory and identity — agents, principals, per-tool identity.",
    tags: ["identity", "directory", "agents", "principals", "accounts", "who"],
  },
  {
    pin: "@workbench/tools-exa",
    package: "exa",
    summary: "Exa — semantic web search and general web search.",
    tags: ["exa", "web", "search", "research"],
  },
  {
    pin: "@workbench/tools-attio",
    package: "attio",
    summary: "Attio CRM — companies, people, deals, tasks, and notes.",
    tags: ["crm", "attio", "companies", "people", "deals", "contacts", "tasks"],
  },
  {
    pin: "@workbench/tools-linear",
    package: "linear",
    summary: "Linear — issues, teams, and users for product/engineering work.",
    tags: ["linear", "issues", "tickets", "engineering", "product", "tasks"],
  },
  {
    pin: "@workbench/tools-granola",
    package: "granola",
    summary: "Granola — meeting notes, transcripts, and folders.",
    tags: ["granola", "meetings", "notes", "transcripts", "calls"],
  },
  {
    pin: "@workbench/tools-vercel",
    package: "vercel",
    summary: "Vercel — projects, deployments, and static/artifact deploys.",
    tags: ["vercel", "deploy", "deployment", "hosting", "projects"],
  },
  {
    pin: "@workbench/tools-fileparser",
    package: "fileparser",
    summary: "Document parsing — read PDFs, documents, and images as text.",
    tags: ["file", "parse", "pdf", "document", "ocr", "attachment"],
  },
  {
    pin: "@workbench/tools-notion",
    package: "notion",
    summary: "Notion — search, read, and create workspace pages and databases.",
    tags: [
      "notion",
      "pages",
      "databases",
      "docs",
      "notes",
      "wiki",
      "knowledge",
    ],
  },
  {
    pin: "@workbench/tools-firecrawl",
    package: "firecrawl",
    summary:
      "Firecrawl — scrape, search, map, crawl, extract, and monitor the web.",
    tags: [
      "firecrawl",
      "web",
      "scrape",
      "crawl",
      "search",
      "research",
      "extract",
    ],
  },
  {
    pin: "@workbench/tools-github",
    package: "github",
    summary: "GitHub — public repository activity and release signals.",
    tags: ["github", "code", "repos", "releases", "engineering"],
  },
  {
    pin: "@workbench/tools-youtube",
    package: "youtube",
    summary: "YouTube — search videos and channels.",
    tags: ["youtube", "video", "social", "content"],
  },
  {
    pin: "@workbench/tools-scrapecreators",
    package: "scrapecreators",
    summary:
      "ScrapeCreators — TikTok, Instagram, Threads, and Pinterest search.",
    tags: [
      "social",
      "tiktok",
      "instagram",
      "threads",
      "pinterest",
      "scrapecreators",
    ],
  },
  {
    pin: "@workbench/tools-reddit",
    package: "reddit",
    summary: "Reddit — search posts and subreddits.",
    tags: ["reddit", "social", "community", "discussions"],
  },
  {
    pin: "@workbench/tools-bluesky",
    package: "bluesky",
    summary: "Bluesky — search public posts.",
    tags: ["bluesky", "social", "posts"],
  },
  {
    pin: "@workbench/tools-x",
    package: "x",
    summary: "X (Twitter) — search posts and accounts.",
    tags: ["x", "twitter", "social", "posts"],
  },
  {
    pin: "@workbench/tools-hackernews",
    package: "hackernews",
    summary: "Hacker News — search stories and discussions.",
    tags: ["hackernews", "hn", "news", "tech", "community"],
  },
  {
    pin: "@workbench/tools-polymarket",
    package: "polymarket",
    summary: "Polymarket — prediction market odds.",
    tags: ["polymarket", "markets", "odds", "predictions"],
  },
  {
    pin: "@workbench/tools-slack",
    package: "slack",
    summary:
      "Slack — list channels, read channel/thread history, keyword-search bot-visible channels, and post messages.",
    tags: ["slack", "channels", "messages", "chat", "search", "post"],
  },
];

const PLATFORM = new Set(MYRA_PLATFORM_BARE_TOOL_NAMES);

/** The catalog (search + hide) tools a package contributes: all it ships minus platform. */
function catalogBareToolsFor(pkg: CatalogPackage): string[] {
  return bareToolNamesForPin(pkg.pin).filter((bare) => !PLATFORM.has(bare));
}

function entry(pkg: CatalogPackage): ToolCatalogEntry {
  return {
    package: pkg.package,
    summary: pkg.summary,
    tags: pkg.tags,
    tools: catalogBareToolsFor(pkg).map((bare) => {
      // LLM name stays wire-form so load_tools / call can match exactly; the
      // description is the human phrase so search_tools never advertises
      // snake_case labels (CL-3268).
      const name = toLlmToolName(canonicalizeToolNames([bare])[0] ?? bare);
      return {
        name,
        description: friendlyToolSummary({ id: "", name }),
      };
    }),
  };
}

/**
 * The dynamic catalog Myra advertises through `search_tools` — every tool her
 * pinned packages ship except the platform set, grouped by package for
 * `load_tools({ package })`. Packages that contribute no non-platform tool are
 * omitted (none today).
 */
export const MYRA_TOOL_CATALOG: ToolCatalog = MYRA_CATALOG_PACKAGES.map(
  entry,
).filter((e) => e.tools.length > 0);

/** The `@scope/package` names Myra pins, derived from the catalog packages. */
export const MYRA_TOOL_PACKAGES: string[] = MYRA_CATALOG_PACKAGES.map(
  (pkg) => pkg.pin,
);

/**
 * Bare names of every catalog tool — the integration half of
 * `PERSONAL_AGENT_BASE_TOOLS`. Grants derive from this so a package's tools are
 * granted exactly when they are cataloged (single source of truth, CL-3190).
 */
export const MYRA_CATALOG_BARE_TOOL_NAMES: string[] =
  MYRA_CATALOG_PACKAGES.flatMap(catalogBareToolsFor);
