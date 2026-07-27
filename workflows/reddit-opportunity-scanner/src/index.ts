import { action, awaitSignal, defineWorkflow } from "@intx/workflow";
import {
  agentStep,
  canonicalizeStepToolName,
  LLM_WRITER_MODEL,
} from "@workbench/agents";
import { buildAnalyzeSystemPrompt, buildCurateSystemPrompt } from "./prompts";

// Curate emits up to 12 opportunities, each carrying a full markdown brief in
// `content` — long-form output. On the fast default model's small/unset
// maxTokens it truncated mid-JSON (the reply came back as an unterminated
// string and the panel could parse no opportunities). Run it on the heavier
// writer model with an explicit ceiling, matching last30days' curate step.
const CURATE_MAX_TOKENS = 16384;

// -------------------------------------------------------------------------
// Workflow metadata
// -------------------------------------------------------------------------

export const label = "Reddit Opportunity Scanner";
export const description =
  "Scan a website, review keyword and subreddit recommendations, then rank Reddit opportunities for follow-up.";
export const kind = "reddit-opportunity-scanner";

// Re-export the user-facing display flow so it travels with the workflow package
// for the server catalog classifier; the client panel imports it from the same
// browser-safe module.
export { DISPLAY_STEPS } from "./display-steps";

// Schedule-field metadata (CL-4538): re-exported so `build-workflow-defs`
// (which reads a workflow module's `INTAKE_FIELDS` export) populates the
// embedded def's `intakeFields` from the SAME list `./blocks.ts`'s intake
// form renders — without this the Routines/attach form has nothing to
// render and the /resume boundary rejects the empty payload it collects.
// Sourced from `./intake-fields` (not `./blocks`) so this server-side entry
// never gains a runtime edge onto `@workbench/blocks`.
export { INTAKE_FIELDS } from "./intake-fields";

// -------------------------------------------------------------------------
// Workflow definition — guided Reddit research flow (CL-2513)
//
// Reddit API calls are deterministic and inspectable. The LLM is reserved for
// genuine judgment: first planning the strategy (analyze), then curating the
// fetched Reddit evidence into opportunities (curate). This mirrors the
// Last30Days collect → curate shape while keeping a human gate before scanning
// (review) and before saving (selection).
// -------------------------------------------------------------------------

// Native `action` handler refs. `collect` folds the same way `persist` did:
// the tool loops over the approved searches in plain TypeScript
// (`collect-tool.ts`), so `map`'s `StepPrimitive`-only typing gap
// (interchange/packages/workflow/src/definition/primitives.ts) no longer
// applies — there is no map left to hit it. This DOES change
// `steps.collect.output`'s shape (bare array → `{ results: [...] }` under
// one `ToolResult.content`, see collect-tool.ts) and collapses N per-search
// checkpoints into 1; `curate`'s system prompt (`prompts.ts`) documents the
// new shape.
export const FIRECRAWL_SCRAPE_HANDLER = canonicalizeStepToolName(
  "reddit-opp-scrape",
  "firecrawl_scrape",
);
export const COLLECT_SEARCHES_HANDLER = canonicalizeStepToolName(
  "reddit-opp-collect",
  "reddit_opportunity_scanner_collect_searches",
);
// Real reddit tool name — never dispatched (the wrapper calls it in-process),
// but declared in collect's effect.requires so the deploy capability walk pins
// @workbench/tools-reddit, whose manifest carries the `scrapecreators`
// provider this workflow's wrapper package cannot claim (providerName: null).
// Without the pin the credential route 403s the whole batch. Same pattern as
// last30days-research / heartbeat.
export const REDDIT_SUBREDDIT_SEARCH_HANDLER =
  "@workbench/tools-reddit/reddit:reddit_subreddit_search";
export const PERSIST_ITEMS_HANDLER = canonicalizeStepToolName(
  "reddit-opp-persist",
  "reddit_opportunity_scanner_persist_items",
);

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // 1. Human supplies the website URL + optional brand / geography / ICP hints.
    intake: awaitSignal({ name: "intake" }),

    // 2. Scrape the site. Native action: `firecrawl_scrape`'s schema
    //    declares `url` verbatim, so intake's own `url` field (renamed from
    //    the pre-migration `inputUrl` to match the tool arg — native
    //    selectors cannot rename a key) passes through unchanged.
    scrape: action({
      handler: FIRECRAWL_SCRAPE_HANDLER,
      input: { from: "steps.intake.output" },
      effect: { requires: [FIRECRAWL_SCRAPE_HANDLER] },
      after: ["intake"],
    }),

    // 3. Infer business profile + keyword/subreddit recommendations.
    //    Pure reasoning over the scraped content + intake hints — no tool.
    analyze: agentStep({
      id: "reddit-opp-analyze",
      title: "Recommend subreddits & keywords",
      systemPrompt: buildAnalyzeSystemPrompt(),
      input: {
        merge: [
          { from: "steps.scrape.output" },
          { from: "steps.intake.output" },
        ],
      },
      after: ["scrape"],
    }),

    // 4. Human accepts / edits the strategy. The panel sends concrete searches
    //    ({subreddit, query, sort, timeframe, limit}) for deterministic collection.
    review: awaitSignal({ name: "recommendation-review", after: ["analyze"] }),

    // 5. Deterministically fetch Reddit evidence for every approved search.
    // Folded from a `map` of single-search `deterministicToolStep`s into one
    // native `action`: `reddit_opportunity_scanner_collect_searches` loops
    // over `review.output.searches` in-process (see `collect-tool.ts`),
    // tolerating a per-search failure inside `content.results[i]` instead of
    // failing the run.
    collect: action({
      handler: COLLECT_SEARCHES_HANDLER,
      input: { from: "steps.review.output" },
      effect: {
        requires: [COLLECT_SEARCHES_HANDLER, REDDIT_SUBREDDIT_SEARCH_HANDLER],
      },
      after: ["review"],
    }),

    // 6. Judge the collected Reddit evidence and produce ranked opportunity briefs.
    //    Narrow the input to just the approved plan + collected results — the
    //    full scrape markdown and analyze blob are dead weight in the curate
    //    context (token cost + distraction), and the prompt only reads these two.
    curate: agentStep({
      id: "reddit-opp-curate",
      title: "Rank the opportunities",
      systemPrompt: buildCurateSystemPrompt(),
      input: { project: { from: "steps" }, fields: ["review", "collect"] },
      model: LLM_WRITER_MODEL,
      maxTokens: CURATE_MAX_TOKENS,
      after: ["collect"],
    }),

    // 7. Human reviews ranked opportunities and selects which to keep.
    //    Payload carries the full selected opportunity objects so `persist`
    //    can map over them directly.
    selection: awaitSignal({
      name: "opportunity-selection",
      after: ["curate"],
    }),

    // 8. Folded from a `map` of single-opportunity `deterministicToolStep`s
    // into one native `action`: `reddit_opportunity_scanner_persist_items`
    // loops over `selected` in-process (see `persist-tool.ts`). Fatal by
    // design (unchanged from the old map): any failed save fails the run.
    // Folding N per-item steps into one action means a crash mid-save now
    // re-runs the WHOLE batch on resume instead of resuming after the
    // already-saved opportunities — a real checkpointing change from the
    // old per-item map, acceptable given a selected batch is small (the
    // panel caps at 12 opportunities).
    persist: action({
      handler: PERSIST_ITEMS_HANDLER,
      input: { from: "steps.selection.output" },
      effect: { requires: [PERSIST_ITEMS_HANDLER] },
      after: ["selection"],
    }),
  },
});
