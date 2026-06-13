import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import {
  gammaFetchJSON,
  isRecord,
  optionalString,
  pollGeneration,
  requiredString,
  resolveConfig,
  stringTool,
  type GammaToolsConfig,
  type ResolvedGammaConfig,
} from './shared';

// Gamma does not expose a list-templates API. This registry maps human-readable
// names to the gammaId of the presentation used as a template in your workspace.
// Update these entries when you add or retire templates in the Gamma workspace.
export const GAMMA_TEMPLATE_REGISTRY: Array<{
  gammaId: string;
  name: string;
  description: string;
}> = [
  // TODO: replace these placeholder entries with actual gammaIds from your Gamma workspace.
  // Get a gammaId by opening a presentation in Gamma and copying the ID from the URL.
  // { gammaId: 'g_xxxxxxxxxx', name: 'Sales Proposal', description: 'Standard sales proposal deck' },
  // { gammaId: 'g_xxxxxxxxxx', name: 'Post-Call Summary', description: 'Summary deck after a discovery or demo call' },
];

function listTemplates(_args: Record<string, unknown>): unknown {
  return GAMMA_TEMPLATE_REGISTRY.map(({ gammaId, name, description }) => ({
    gammaId,
    name,
    description,
  }));
}

// Direct HTTP to Gamma SaaS API — see AGENTS.md 'Third-party generation APIs' and packages/tools-gamma/README.md
async function createFromTemplate(
  config: ResolvedGammaConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const gammaId = requiredString(args, 'gammaId');
  const prompt = requiredString(args, 'prompt');
  const title = optionalString(args['title']);
  const themeId = optionalString(args['themeId']);

  const body: Record<string, unknown> = {
    gammaId,
    prompt,
    ...(title !== null ? { title } : {}),
    ...(themeId !== null ? { themeId } : {}),
  };

  const response = await gammaFetchJSON(
    config,
    { method: 'POST', path: '/generations/from-template', body },
    signal
  );

  if (!isRecord(response)) {
    throw new Error('Unexpected response from Gamma generations API');
  }

  const generationId = response['generationId'];
  if (typeof generationId !== 'string') {
    throw new Error('Gamma generation did not return a generationId');
  }

  const result = await pollGeneration(config, generationId, signal);
  return { gammaUrl: result.gammaUrl, gammaId: result.gammaId };
}

export const GAMMA_LIST_TEMPLATES_DEFINITION: ToolDefinition = {
  name: 'gamma_list_templates',
  description:
    'List available Gamma presentation templates from the workspace registry. Returns an array of templates with gammaId, name, and description. Use names when presenting options to the user; use gammaId internally when calling gamma_create_from_template.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const GAMMA_CREATE_FROM_TEMPLATE_DEFINITION: ToolDefinition = {
  name: 'gamma_create_from_template',
  description:
    'Generate a new Gamma presentation based on an existing template presentation. Provide the gammaId of the template, a prompt describing the content to generate, and an optional title and themeId. Returns the new deck URL (gammaUrl) and its gammaId. This is an async operation that polls until the generation is complete.',
  inputSchema: {
    type: 'object',
    properties: {
      gammaId: {
        type: 'string',
        description: 'The gammaId of the template presentation to generate from.',
      },
      prompt: {
        type: 'string',
        description: 'Instructions describing the content and structure of the new deck.',
      },
      title: {
        type: 'string',
        description: 'Optional title for the generated deck.',
      },
      themeId: {
        type: 'string',
        description: 'Optional theme ID to apply (from gamma_list_themes).',
      },
    },
    required: ['gammaId', 'prompt'],
  },
};

export const TEMPLATE_DEFINITIONS: ToolDefinition[] = [
  GAMMA_LIST_TEMPLATES_DEFINITION,
  GAMMA_CREATE_FROM_TEMPLATE_DEFINITION,
];

export function createTemplateTools(config: GammaToolsConfig): AgentTool[] {
  const resolved = resolveConfig(config);
  return [
    {
      kind: 'string',
      definition: GAMMA_LIST_TEMPLATES_DEFINITION,
      handler: (args) => Promise.resolve(JSON.stringify(listTemplates(args), null, 2)),
    },
    stringTool(GAMMA_CREATE_FROM_TEMPLATE_DEFINITION, (args, signal) =>
      createFromTemplate(resolved, args, signal)
    ),
  ];
}
