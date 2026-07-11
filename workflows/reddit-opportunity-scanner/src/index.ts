import { awaitSignal, defineWorkflow, map } from "@intx/workflow";
import {
  deterministicToolStep,
  inlineInferenceStep,
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

// -------------------------------------------------------------------------
// Workflow definition — guided Reddit research flow (CL-2513)
//
// Reddit API calls are deterministic and inspectable. The LLM is reserved for
// genuine judgment: first planning the strategy (analyze), then curating the
// fetched Reddit evidence into opportunities (curate). This mirrors the
// Last30Days collect → curate shape while keeping a human gate before scanning
// (review) and before saving (selection).
// -------------------------------------------------------------------------

// The collect step's per-row tool-arg mapping — exported so the fidelity
// integration test asserts against the REAL field names (a typo here fails the
// map trap the test guards, not a hand-rolled copy).
export const COLLECT_ARG_MAP = {
  subreddit: { from: "subreddit" },
  query: { from: "query" },
  sort: { from: "sort" },
  timeframe: { from: "timeframe" },
  limit: { from: "limit" },
} as const;

// The persist step's per-opportunity tool-arg mapping — exported for the same
// reason: the fidelity test reads `title`/`content` from here, not a copy.
export const PERSIST_ARG_MAP = {
  title: { from: "title" },
  kind: { literal: "reddit-opportunity-scan" },
  content: { from: "content" },
} as const;

const collectStep = deterministicToolStep({
  id: "reddit-opp-collect-search",
  title: "Search each subreddit",
  tool: "reddit_subreddit_search",
  // map passes each approved search as trigger.payload.
  input: { from: "trigger.payload" },
  argMap: COLLECT_ARG_MAP,
  nonFatal: true,
});

const persistStep = deterministicToolStep({
  id: "reddit-opp-persist-item",
  title: "Save each opportunity",
  tool: "artifact_create",
  // map passes each selected opportunity as trigger.payload.
  input: { from: "trigger.payload" },
  argMap: PERSIST_ARG_MAP,
});

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // 1. Human supplies the website URL + optional brand / geography / ICP hints.
    intake: awaitSignal({ name: "intake" }),

    // 2. Scrape the site deterministically (was a firecrawl_scrape tool call).
    scrape: deterministicToolStep({
      id: "reddit-opp-scrape",
      title: "Scan the website",
      tool: "firecrawl_scrape",
      input: { from: "steps.intake.output" },
      argMap: { url: { from: "inputUrl" } },
      after: ["intake"],
    }),

    // 3. Infer business profile + keyword/subreddit recommendations.
    //    Pure reasoning over the scraped content + intake hints — no tool.
    analyze: inlineInferenceStep({
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

    // 5. Deterministically fetch Reddit evidence for each approved search.
    collect: map({
      over: { from: "steps.review.output.searches" },
      step: collectStep,
      after: ["review"],
    }),

    // 6. Judge the collected Reddit evidence and produce ranked opportunity briefs.
    //    Narrow the input to just the approved plan + collected results — the
    //    full scrape markdown and analyze blob are dead weight in the curate
    //    context (token cost + distraction), and the prompt only reads these two.
    curate: inlineInferenceStep({
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

    // 8. One artifact per selected opportunity, saved deterministically.
    persist: map({
      over: { from: "steps.selection.output.selected" },
      step: persistStep,
      after: ["selection"],
    }),
  },
});
