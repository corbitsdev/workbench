import { LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';
import type { WorkflowType } from '@workbench/workflow-core';
import { redditOpportunityScanArtifactSchema } from './schema';

const INFERENCE_REQUIREMENT = {
  providerName: 'openai-compatible',
  source: 'tenant',
  name: LLM_CREDENTIAL_NAME,
  defaultModel: LLM_DEFAULT_MODEL,
} as const;

export const redditOpportunityScannerWorkflow: WorkflowType = {
  kind: 'reddit-opportunity-scanner',
  name: 'Reddit Opportunity Scanner',
  description:
    'Scan a website, review keyword and subreddit recommendations, then rank Reddit opportunities for follow-up.',
  steps: [
    {
      name: 'intake',
      label: 'Start Scan',
      description: 'Collect the website URL and optional brand or ICP hints.',
      credentialRequirements: [],
    },
    {
      name: 'analyze',
      label: 'Business Summary',
      description:
        'Use the site content to infer what the business sells, its keywords, competitors, and audience signals.',
      credentialRequirements: [INFERENCE_REQUIREMENT],
      tools: ['firecrawl_scrape'],
    },
    {
      name: 'review',
      label: 'Recommendation Review',
      description: 'Let the operator accept, reject, or edit recommended keywords and subreddits.',
      credentialRequirements: [],
    },
    {
      name: 'scan',
      label: 'Reddit Scan',
      description:
        'Use ephemeral workflow inference to guide Reddit searches for approved keywords, subreddits, and competitors, then score the best opportunities.',
      credentialRequirements: [INFERENCE_REQUIREMENT],
      tools: ['reddit_search', 'reddit_subreddit_search'],
    },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      inputUrl: { type: 'string', description: 'Website URL to scan' },
      brandName: { type: 'string', description: 'Optional brand name' },
      targetGeography: { type: 'string', description: 'Optional target geography' },
      icpHints: { type: 'string', description: 'Optional ICP or audience hints' },
    },
    required: ['inputUrl'],
  },
  outputSchema: redditOpportunityScanArtifactSchema,
  deriveCurrentStep: (status) => {
    switch (status) {
      case 'pending':
      case 'failed':
        return 'intake';
      case 'analyzing':
        return 'analyze';
      case 'reviewing':
        return 'review';
      case 'running':
      case 'generating':
      case 'done':
        return 'scan';
      default:
        throw new Error(`Unknown workflow status: ${status}`);
    }
  },
  serializeStepState: ({ status, input, artifacts }) => {
    const intake = status !== 'pending' && status !== 'failed';
    const analyze =
      status === 'analyzing' ||
      status === 'reviewing' ||
      status === 'running' ||
      status === 'generating' ||
      status === 'done';
    const review =
      status === 'reviewing' ||
      status === 'running' ||
      status === 'generating' ||
      status === 'done';
    const scan = status === 'done';

    const redditArtifacts = (artifacts ?? []).filter(
      (a: { kind?: string }) => a.kind === 'reddit-opportunity-scan'
    );

    const parseArtifactContent = (
      a: { content?: string; [key: string]: unknown } | undefined
    ): unknown => {
      if (!a || typeof a.content !== 'string') return undefined;
      try {
        return JSON.parse(a.content);
      } catch {
        return undefined;
      }
    };

    const draftArtifact = redditArtifacts.find((a: { status?: string }) => a.status === 'draft');
    const approvedArtifact = redditArtifacts.find(
      (a: { status?: string }) => a.status === 'approved'
    );

    return {
      intake: { completed: intake, input },
      analyze: { completed: analyze },
      review: {
        completed: review,
        artifactId: draftArtifact?.id,
        artifact: parseArtifactContent(draftArtifact),
      },
      scan: {
        completed: scan,
        artifactId: approvedArtifact?.id,
        artifact: parseArtifactContent(approvedArtifact),
      },
    };
  },
};
