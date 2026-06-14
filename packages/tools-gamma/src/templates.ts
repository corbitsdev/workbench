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

// Direct HTTP to Gamma SaaS API — see AGENTS.md 'Third-party generation APIs' and packages/tools-gamma/README.md
// Response shape: { data: Template[], hasMore: boolean, nextCursor?: string }
async function listTemplates(
  config: ResolvedGammaConfig,
  _args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  return fetchGammaTemplatesResolved(config, signal);
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

export type GammaTemplate = {
  gammaId: string;
  name: string;
  description: string | null;
};

async function fetchGammaTemplatesResolved(
  config: ResolvedGammaConfig,
  signal?: AbortSignal
): Promise<GammaTemplate[]> {
  const result = await gammaFetchJSON(config, { method: 'GET', path: '/templates' }, signal);

  if (!isRecord(result) || !Array.isArray(result['data'])) {
    return [];
  }

  const templates: GammaTemplate[] = [];
  for (const item of result['data'] as unknown[]) {
    if (!isRecord(item)) continue;
    const gammaId = optionalString(item['id']) ?? optionalString(item['gammaId']);
    if (gammaId === null) continue;
    templates.push({
      gammaId,
      name: optionalString(item['name']) ?? '',
      description: optionalString(item['description']),
    });
  }
  return templates;
}

export async function fetchGammaTemplates(
  config: GammaToolsConfig,
  signal?: AbortSignal
): Promise<GammaTemplate[]> {
  return fetchGammaTemplatesResolved(resolveConfig(config), signal);
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
    stringTool(GAMMA_LIST_TEMPLATES_DEFINITION, (args, signal) =>
      listTemplates(resolved, args, signal)
    ),
    stringTool(GAMMA_CREATE_FROM_TEMPLATE_DEFINITION, (args, signal) =>
      createFromTemplate(resolved, args, signal)
    ),
  ];
}
