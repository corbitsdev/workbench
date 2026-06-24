import { awaitSignal, defineWorkflow } from '@intx/workflow';
import { deterministicToolStep, inlineInferenceStep } from '@workbench/agents';
import { buildWriterSystemPrompt } from './prompts';

export const label = 'last30days Research';
export const description =
  'Research the last 30 days of market and community signal, synthesize a cited brief, and save it as an artifact.';
export const kind = 'last30days-research';

const sourceSearchInput = { from: 'steps.intake.output' } as const;
const sourceQueryArgMap = { query: { from: 'query' } } as const;

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    intake: awaitSignal({ name: 'intake' }),

    hackernews: deterministicToolStep({
      id: 'last30days-fetch-hackernews',
      tool: 'hackernews_search',
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ['intake'],
    }),

    github: deterministicToolStep({
      id: 'last30days-fetch-github',
      tool: 'github_activity',
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ['intake'],
    }),

    web: deterministicToolStep({
      id: 'last30days-fetch-web',
      tool: 'exa_search',
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ['intake'],
    }),

    reddit: deterministicToolStep({
      id: 'last30days-fetch-reddit',
      tool: 'reddit_search',
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ['intake'],
    }),

    x: deterministicToolStep({
      id: 'last30days-fetch-x',
      tool: 'x_search',
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ['intake'],
    }),

    youtube: deterministicToolStep({
      id: 'last30days-fetch-youtube',
      tool: 'youtube_search',
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ['intake'],
    }),

    bluesky: deterministicToolStep({
      id: 'last30days-fetch-bluesky',
      tool: 'bluesky_search',
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ['intake'],
    }),

    brief: deterministicToolStep({
      id: 'last30days-build-brief',
      tool: 'last30days_workflow_brief',
      input: { from: 'steps' },
      after: ['hackernews', 'github', 'web', 'reddit', 'x', 'youtube', 'bluesky'],
    }),

    write: inlineInferenceStep({
      id: 'last30days-write-report',
      systemPrompt: buildWriterSystemPrompt(),
      input: {
        merge: [{ from: 'steps.intake.output' }, { from: 'steps.brief.output' }],
      },
      after: ['brief'],
    }),

    persist: deterministicToolStep({
      id: 'last30days-persist-artifact',
      tool: 'write_artifact',
      input: {
        merge: [
          { from: 'steps.intake.output' },
          { from: 'steps.brief.output' },
          { from: 'steps.write.output' },
        ],
      },
      argMap: {
        title: { from: 'topic' },
        body: { from: 'reply' },
        kind: { literal: 'research' },
        content: { from: 'content' },
      },
      after: ['write'],
    }),
  },
});
