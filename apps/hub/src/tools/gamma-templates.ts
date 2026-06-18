import type { AgentTool } from '@intx/agent';
import type { DB } from '@intx/db';
import { GAMMA_LIST_TEMPLATES_DEFINITION } from '@workbench/tools-gamma';
import type { ContextToolEntry } from '../lib/tool-registry';
import { listLatestGammaTemplates } from '../lib/gamma-templates';

function createGammaListTemplatesTool(context: { db: DB['db']; tenantId: string }): AgentTool {
  return {
    kind: 'string',
    definition: GAMMA_LIST_TEMPLATES_DEFINITION,
    handler: async () => {
      const templates = await listLatestGammaTemplates(context.db, context.tenantId);
      return JSON.stringify(
        templates.map((t) => ({
          gammaId: t.gammaId,
          name: t.name,
          systemPrompt: t.systemPrompt,
        }))
      );
    },
  };
}

export const GAMMA_LIST_TEMPLATES_HUB_TOOL: ContextToolEntry = {
  definition: GAMMA_LIST_TEMPLATES_DEFINITION,
  createTools: (context) => [createGammaListTemplatesTool(context)],
};
