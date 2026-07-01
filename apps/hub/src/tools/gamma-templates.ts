import type { AgentTool } from "@intx/agent";
import type { DB } from "@intx/db";
import { GAMMA_LIST_TEMPLATES_DEFINITION } from "@workbench/tools-gamma";
import type { ContextToolEntry } from "../lib/tool-registry";
import { listLatestGammaTemplates } from "../lib/gamma-templates";

// This ContextToolEntry is how the AGENT lists Gamma templates (during a chat
// or workflow step). The human-facing surfaces list them over HTTP instead: the
// workflow intake UI and the settings page both call `GET /gamma-templates`
// (see routes/gamma-templates.ts), which additionally walks the ancestor chain
// and computes per-caller `canManage`. This tool lists only the active tenant's
// latest versions and projects to what the model needs.

function createGammaListTemplatesTool(context: {
  db: DB["db"];
  tenantId: string;
}): AgentTool {
  return {
    kind: "string",
    definition: GAMMA_LIST_TEMPLATES_DEFINITION,
    handler: async () => {
      const templates = await listLatestGammaTemplates(
        context.db,
        context.tenantId,
      );
      return JSON.stringify(
        templates.map((t) => ({
          gammaId: t.gammaId,
          name: t.name,
          description: t.description,
        })),
      );
    },
  };
}

export const GAMMA_LIST_TEMPLATES_HUB_TOOL: ContextToolEntry = {
  definition: GAMMA_LIST_TEMPLATES_DEFINITION,
  createTools: (context) => [createGammaListTemplatesTool(context)],
};
