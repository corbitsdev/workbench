import { awaitSignal, defineWorkflow } from '@intx/workflow';
import { deterministicToolStep, inlineInferenceStep } from '@workbench/agents';
import { buildWriterSystemPrompt } from './prompts';

export const label = 'last30days Research';
export const description =
  'Research the last 30 days of market and community signal, synthesize a cited brief, and save it as an artifact.';
export const kind = 'last30days-research';

const intakeInput = { from: 'steps.intake.output' } as const;

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    intake: awaitSignal({ name: 'intake' }),

    normalize: deterministicToolStep({
      id: 'last30days-normalize-intake',
      tool: 'last30days_workflow_normalize_intake',
      input: intakeInput,
      after: ['intake'],
    }),

    extract: deterministicToolStep({
      id: 'last30days-extract-entities',
      tool: 'last30days_core_extract',
      input: { from: 'steps.normalize.output' },
      argMap: { topic: { from: 'content' } },
      after: ['normalize'],
    }),

    hackernews: deterministicToolStep({
      id: 'last30days-fetch-hackernews',
      tool: 'hackernews_search',
      input: { from: 'steps.normalize.output' },
      argMap: { query: { from: 'content' } },
      after: ['extract'],
    }),

    github: deterministicToolStep({
      id: 'last30days-fetch-github',
      tool: 'github_activity',
      input: { from: 'steps.normalize.output' },
      argMap: { query: { from: 'content' } },
      after: ['extract'],
    }),

    web: deterministicToolStep({
      id: 'last30days-fetch-web',
      tool: 'exa_search',
      input: { from: 'steps.normalize.output' },
      argMap: { query: { from: 'content' } },
      after: ['extract'],
    }),

    reddit: deterministicToolStep({
      id: 'last30days-fetch-reddit',
      tool: 'reddit_search',
      input: { from: 'steps.normalize.output' },
      argMap: { query: { from: 'content' } },
      after: ['extract'],
    }),

    x: deterministicToolStep({
      id: 'last30days-fetch-x',
      tool: 'x_search',
      input: { from: 'steps.normalize.output' },
      argMap: { query: { from: 'content' } },
      after: ['extract'],
    }),

    youtube: deterministicToolStep({
      id: 'last30days-fetch-youtube',
      tool: 'youtube_search',
      input: { from: 'steps.normalize.output' },
      argMap: { query: { from: 'content' } },
      after: ['extract'],
    }),

    bluesky: deterministicToolStep({
      id: 'last30days-fetch-bluesky',
      tool: 'bluesky_search',
      input: { from: 'steps.normalize.output' },
      argMap: { query: { from: 'content' } },
      after: ['extract'],
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

    validate: deterministicToolStep({
      id: 'last30days-validate-report',
      tool: 'last30days_validate',
      input: { from: 'steps.write.output' },
      argMap: {
        body: { from: 'reply' },
        citations: { literal: [] },
        returnedItemUrls: { literal: [] },
      },
      after: ['write'],
    }),

    persist: deterministicToolStep({
      id: 'last30days-persist-artifact',
      tool: 'write_artifact',
      input: {
        merge: [{ from: 'steps.intake.output' }, { from: 'steps.write.output' }],
      },
      argMap: {
        title: { from: 'topic' },
        body: { from: 'reply' },
        citations: { literal: [] },
        kind: { literal: 'research' },
      },
      after: ['validate'],
    }),
  },
});
