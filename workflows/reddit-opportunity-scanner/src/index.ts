import { defineAgent } from '@intx/agent';
import { awaitSignal, defineWorkflow, map, step } from '@intx/workflow';
import {
  canonicalizeToolNames,
  deterministicToolStep,
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
} from '@workbench/agents';

const scanAgent = defineAgent({
  id: 'reddit-opportunity-scan',
  description:
    'Searches the given subreddits and keywords for buying signals, pain points, and competitor mentions, then ranks the top opportunities.',
  systemPrompt: [
    'You are a Reddit opportunity-scanning agent.',
    'The user will supply a list of subreddits and keywords.',
    'Search those subreddits for threads that exhibit buying signals, expressed pain points, or competitor mentions.',
    'Return ONLY valid JSON — no markdown fences, no prose — in this exact shape:',
    '{"opportunities":[{"id":"<slug>","title":"<thread title>","subreddit":"<name without r/>","signal":"buying-signal|pain-point|competitor-mention","detail":"<one sentence explaining why this is relevant>","url":"<full reddit url>"}]}',
    'id must be a short, URL-safe slug unique within the response.',
    'Omit url if unavailable. Return at most 20 opportunities, ranked by relevance descending.',
  ].join('\n'),
  tools: [],
  capabilities: canonicalizeToolNames(['reddit_search', 'reddit_subreddit_search']),
  inference: { sources: [{ provider: 'openai-compatible', model: LLM_DEFAULT_MODEL }] },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const label = 'Reddit Opportunity Scanner';
export const description =
  'Scan subreddits for buying signals, pain points, and competitor mentions.';
export const kind = 'reddit-opportunity-scanner';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    // Step 1 — human provides subreddits + keywords to scan
    intake: awaitSignal({ name: 'intake' }),

    // Step 2 — agent searches Reddit and ranks opportunities as STRICT JSON
    scan: step({
      agent: scanAgent,
      input: { from: 'steps.intake.output' },
      after: ['intake'],
    }),

    // Step 3 — human reviews ranked opportunities and selects which to keep
    // Payload carries the full selected opportunity objects so `persist` can
    // map over them without re-fetching scan output through a JSON-in-string
    // selector (agent step output is {reply:string}; selectors cannot parse it).
    review: awaitSignal({ name: 'recommendation-review', after: ['scan'] }),

    // Step 4 — one artifact per selected opportunity, saved deterministically
    persist: map({
      over: { from: 'steps.review.output.selected' },
      step: deterministicToolStep({
        id: 'reddit-opp-persist-item',
        tool: 'artifact_create',
        input: { from: 'trigger.payload' },
        argMap: {
          title: { from: 'title' },
          kind: { literal: 'document' },
          content: { from: 'detail' },
        },
      }),
      after: ['review'],
    }),
  },
});
