import type { ToolCatalog, ToolCatalogEntry } from "@workbench/tools-catalog";
import {
  deriveBareToolDescriptions,
  deriveMyraCatalogPackages,
  loadCommittedToolManifestFactories,
} from "@workbench/tool-manifest";
import {
  bareToolNamesForPin,
  canonicalizeToolNames,
  toLlmToolName,
} from "./tool-names";
import { friendlyToolSummary } from "./friendly-tool-summary";

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
 *
 * Catalog description style bar (CL-4137): myraCatalog.summary (declared per
 * package in each tools-star/src/tool-manifest.ts) and the per-tool manifest
 * descriptions it merges into search_tools keywords are Myra's decision
 * surface, matched on by search_tools/search_skills, not prose written for a
 * human reader. Every one should: state the one job the tool does, not its
 * category; name concrete trigger conditions or inputs, not vague scope
 * ("various things", "handles X"); avoid marketing prose (no "powerful",
 * "easily", "seamless", "robust", "comprehensive", see CATALOG_BANNED_PHRASES
 * in the tool-manifest package); and stay concise, one sentence and at most
 * two for myraCatalog.summary, a third only as a disambiguation exception.
 * Per-tool descriptions may run longer when they double as real
 * parameter/usage guidance for the model, so they are not length-capped
 * mechanically. assertCatalogDescriptionStyle (also in the tool-manifest
 * package) enforces what a lint rule can check: non-empty, the summary
 * length ceiling, and the banned-phrase list. Stating the one job and naming
 * concrete triggers stay a human review bar at PR time.
 */
type CatalogPackage = {
  /** The `@scope/package` pin name (one published tarball). */
  pin: string;
  /** Catalog display key; also the `load_tools({ package })` argument. */
  package: string;
  summary: string;
  tags: string[];
};

const COMMITTED_TOOL_FACTORIES = loadCommittedToolManifestFactories();

export const MYRA_CATALOG_PACKAGES: CatalogPackage[] =
  deriveMyraCatalogPackages(COMMITTED_TOOL_FACTORIES);

// Real manifest descriptions per pin/bare-name — the widened `search_tools`
// corpus. Kept separate from the friendly display phrase so results never
// advertise snake_case labels.
const CATALOG_TOOL_DESCRIPTIONS = deriveBareToolDescriptions(
  COMMITTED_TOOL_FACTORIES,
);

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
      // snake_case labels (CL-3268). The tool's real manifest description rides
      // along as search-only `keywords` so recall isn't limited to that phrase.
      const name = toLlmToolName(canonicalizeToolNames([bare])[0] ?? bare);
      const keywords = CATALOG_TOOL_DESCRIPTIONS[pkg.pin]?.[bare];
      return {
        name,
        description: friendlyToolSummary({ id: "", name }),
        ...(keywords !== undefined && keywords.trim() !== ""
          ? { keywords }
          : {}),
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
