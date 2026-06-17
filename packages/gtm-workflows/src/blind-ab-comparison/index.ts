import type { WorkflowType } from '@workbench/workflow-core';

export {
  AB_COMPARISON_MODELS_BY_PLUGIN,
  AB_COMPARISON_PROVIDER_PLUGINS,
  ANTHROPIC_AB_COMPARISON_MODELS,
  GOOGLE_GENAI_AB_COMPARISON_MODELS,
  OPENAI_AB_COMPARISON_MODELS,
  OPENCODE_ZEN_CHAT_COMPLETIONS_MODELS,
  defaultAbComparisonModel,
  isAbComparisonModelAllowed,
  listAbComparisonModels,
  validateAbComparisonProviders,
  type AbComparisonProviderPlugin,
} from './models';

export const AB_COMPARISON_WORKFLOW_KIND = 'blind-ab-comparison';

export type AbComparisonProviderOption = {
  credentialId: string;
  providerName: string;
  providerPlugin: string;
  model?: string;
  skillIds: string[];
};

export type AbComparisonInput = {
  source: 'text' | 'artifact';
  text?: string;
  artifactId?: string;
};

export type AbComparisonBranch = {
  id: string;
  option: AbComparisonProviderOption;
  output?: string;
  status: 'pending' | 'running' | 'done' | 'error';
  errorMessage?: string;
};

export type AbComparisonRanking = {
  branchIds: string[]; // ordered best -> worst
  feedback?: Record<string, string>; // branchId -> feedback text
};

export const blindAbComparisonWorkflow: WorkflowType = {
  kind: AB_COMPARISON_WORKFLOW_KIND,
  name: 'Blind A/B Comparison',
  description:
    'Run the same prompt through multiple inference providers, compare outputs blind, and rank the results.',
  steps: [
    {
      name: 'providers',
      label: 'Providers',
      description: 'Select two or more inference providers to compare.',
      credentialRequirements: [
        {
          providerName: 'openai-compatible',
          source: 'tenant',
          name: 'LLM',
        },
        {
          providerName: 'openai',
          source: 'tenant',
          name: 'OpenAI',
        },
        {
          providerName: 'anthropic',
          source: 'tenant',
          name: 'Anthropic',
        },
      ],
    },
    {
      name: 'configure',
      label: 'Configure',
      description: 'Attach optional skills and a shared system prompt.',
      credentialRequirements: [],
    },
    {
      name: 'input',
      label: 'Input',
      description: 'Define the text or artifact to run.',
      credentialRequirements: [],
    },
    {
      name: 'execute',
      label: 'Execute',
      description: 'Run all provider branches concurrently.',
      credentialRequirements: [],
    },
    {
      name: 'compare',
      label: 'Compare',
      description: 'Blind rank the outputs.',
      credentialRequirements: [],
    },
    {
      name: 'feedback',
      label: 'Feedback',
      description: 'Optional per-result feedback.',
      credentialRequirements: [],
    },
    {
      name: 'persist',
      label: 'Persist',
      description: 'Save results as artifacts.',
      credentialRequirements: [],
    },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      providers: {
        type: 'array',
        items: { type: 'object' },
      },
      systemPrompt: { type: 'string' },
      input: { type: 'object' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      branches: { type: 'array' },
      ranking: { type: 'object' },
      artifactId: { type: 'string' },
    },
  },
  deriveRunTitle: (input) => {
    const i = input as { input?: { source?: string; text?: string } } | undefined;
    if (i?.input?.text) {
      const text = i.input.text.slice(0, 40);
      return `${text}${i.input.text.length > 40 ? '…' : ''}`;
    }
    return 'Blind A/B Comparison';
  },
  deriveCurrentStep: (status) => {
    switch (status) {
      case 'pending':
      case 'providers':
        return 'providers';
      case 'configure':
        return 'configure';
      case 'input':
        return 'input';
      case 'running':
      case 'execute':
        return 'execute';
      case 'reviewing':
      case 'compare':
        return 'compare';
      case 'feedback':
        return 'feedback';
      case 'done':
      case 'persist':
        return 'persist';
      case 'failed':
        return 'providers';
      default:
        return 'providers';
    }
  },
  serializeStepState: ({ status, input, artifacts }) => {
    const i = input as Record<string, unknown>;
    const providers = i?.providers as AbComparisonProviderOption[] | undefined;
    const systemPrompt = i?.systemPrompt as string | undefined;
    const runInput = i?.input as AbComparisonInput | undefined;
    const branches = i?.branches as AbComparisonBranch[] | undefined;
    const ranking = i?.ranking as AbComparisonRanking | undefined;
    const persisted = status === 'done' || status === 'persist';

    return {
      providers: {
        completed: providers !== undefined && providers.length > 0,
        providers,
      },
      configure: {
        completed: providers !== undefined && providers.length > 0,
        systemPrompt,
      },
      input: {
        completed: runInput !== undefined,
        input: runInput,
      },
      execute: {
        completed:
          branches !== undefined &&
          branches.every((b) => b.status === 'done' || b.status === 'error'),
        branches,
      },
      compare: {
        completed: ranking !== undefined,
        ranking,
      },
      feedback: {
        completed: ranking !== undefined,
        ranking,
      },
      persist: {
        completed: persisted,
        artifacts: artifacts.filter((a) => a.kind === 'ab-comparison-result'),
      },
    };
  },
};
