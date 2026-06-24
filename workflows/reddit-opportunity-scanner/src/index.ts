import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, map, step } from '@intx/workflow';
import {
  canonicalizeToolNames,
  deterministicToolStep,
  inlineInferenceStep,
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
} from '@workbench/agents';
import { buildAnalyzeSystemPrompt, buildScanSystemPrompt } from './prompts';

// -------------------------------------------------------------------------
// Agent definitions
// -------------------------------------------------------------------------

// The scan step genuinely calls Reddit tools: it runs `reddit_search` /
// `reddit_subreddit_search` for the approved keywords across the approved
// subreddits, then ranks the opportunities. Per CLAUDE.md a tool-using
// reasoning step stays a deployed `step({ agent })` (real tool-capable
// harness), not an inline-inference step. This mirrors the pre-M6 `scan`
// stage, which carried both an inference source and the reddit tools.
const scanAgent = defineAgent({
  id: 'reddit-opportunity-scan',
  description:
    'Searches the approved subreddits and keywords for buying signals, pain points, and competitor mentions, then ranks the top opportunities.',
  systemPrompt: buildScanSystemPrompt(),
  tools: [],
  capabilities: canonicalizeToolNames(['reddit_search', 'reddit_subreddit_search']),
  inference: {
    sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }],
  },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

// -------------------------------------------------------------------------
// Workflow metadata
// -------------------------------------------------------------------------

export const label = 'Reddit Opportunity Scanner';
export const description =
  'Scan a website, review keyword and subreddit recommendations, then rank Reddit opportunities for follow-up.';
export const kind = 'reddit-opportunity-scanner';

// -------------------------------------------------------------------------
// Workflow definition — restored pre-M6 step graph (CL-2256)
//
// The original pre-M6 reddit-scanner (packages/gtm-workflows, deleted in the
// M6 hard cutover 707186d6) ran: intake (URL + hints) → analyze (Firecrawl
// scrape + LLM business/keyword/subreddit inference) → review (human accept /
// edit of recommendations) → scan (Reddit search + score). The M6 port
// stripped this to intake(subreddits/keywords) → scan(agent) → review →
// persist, dropping the URL intake, the Firecrawl analyze stage, and the
// recommendations review.
//
// This restores the analyze + review stages natively while keeping the
// human-in-the-loop opportunity selection + per-item artifact persist the
// product direction added in the port.
//
// Step graph:
//   intake     awaitSignal           intake                → {inputUrl, brandName?, targetGeography?, icpHints?}
//   scrape     deterministicToolStep firecrawl_scrape      argMap {url ← inputUrl}
//   analyze    inlineInferenceStep   merge scrape+intake   → business profile + keyword/subreddit recommendations JSON
//   review     awaitSignal           recommendation-review → approved keywords/subreddits/competitors + business context
//   scan       step({agent})         reddit_search/_subreddit_search → ranked opportunities JSON
//   selection  awaitSignal           opportunity-selection → {selected: Opportunity[]}
//   persist    map over selection.output.selected
//     └ deterministicToolStep artifact_create argMap {title, kind, content}
//
// `scrape` is a deterministic firecrawl tool call; `analyze` is a pure
// single-turn reasoning step (inline inference, CL-2251) over the scraped
// content — it never calls a tool. `scan` genuinely calls the Reddit tools,
// so it stays a deployed tool-capable agent step. `persist` fans out one
// deterministic artifact_create per selected opportunity via `map`
// (sequential in the v1 runtime).
// -------------------------------------------------------------------------

const persistStep = deterministicToolStep({
  id: 'reddit-opp-persist-item',
  tool: 'artifact_create',
  // map passes each selected opportunity as trigger.payload.
  input: { from: 'trigger.payload' },
  argMap: {
    title: { from: 'title' },
    kind: { literal: 'document' },
    content: { from: 'detail' },
  },
});

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    // 1. Human supplies the website URL + optional brand / geography / ICP hints.
    intake: awaitSignal({ name: 'intake' }),

    // 2. Scrape the site deterministically (was a firecrawl_scrape tool call).
    scrape: deterministicToolStep({
      id: 'reddit-opp-scrape',
      tool: 'firecrawl_scrape',
      input: { from: 'steps.intake.output' },
      argMap: { url: { from: 'inputUrl' } },
      after: ['intake'],
    }),

    // 3. Infer business profile + keyword/subreddit recommendations.
    //    Pure reasoning over the scraped content + intake hints — no tool.
    analyze: inlineInferenceStep({
      id: 'reddit-opp-analyze',
      systemPrompt: buildAnalyzeSystemPrompt(),
      input: {
        merge: [{ from: 'steps.scrape.output' }, { from: 'steps.intake.output' }],
      },
      after: ['scrape'],
    }),

    // 4. Human accepts / edits recommended keywords + subreddits. The panel
    //    sends the approved keywords, subreddits, competitors, and business
    //    context for the scan step to search and rank against.
    review: awaitSignal({ name: 'recommendation-review', after: ['analyze'] }),

    // 5. Search Reddit for the approved terms across the approved subreddits
    //    and rank opportunities as strict JSON (genuine tool-using step).
    scan: step({
      agent: scanAgent,
      input: { from: 'steps.review.output' },
      after: ['review'],
    }),

    // 6. Human reviews ranked opportunities and selects which to keep.
    //    Payload carries the full selected opportunity objects so `persist`
    //    can map over them directly.
    selection: awaitSignal({ name: 'opportunity-selection', after: ['scan'] }),

    // 7. One artifact per selected opportunity, saved deterministically.
    persist: map({
      over: { from: 'steps.selection.output.selected' },
      step: persistStep,
      after: ['selection'],
    }),
  },
});
