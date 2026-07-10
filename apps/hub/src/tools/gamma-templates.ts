import type { AgentTool } from "@intx/agent";
import type { DB } from "@intx/db";
import { GAMMA_LIST_TEMPLATES_DEFINITION } from "@workbench/tools-gamma";
import type { ContextToolEntry } from "../lib/tool-registry";
import { listLatestGammaTemplates } from "../lib/gamma-templates";

// Hub-side execution for the hub-backed `gamma_list_templates` tool (the
// `gammaTemplates` factory in @workbench/tools-gamma), dispatched over
// `POST /api/internal/hub-tools/run` for both live agent sessions and
// workflow steps. The human-facing surfaces list templates over HTTP: the
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

export const GAMMA_TEMPLATES_HUB_TOOLS: Record<string, ContextToolEntry> = {
  gamma_list_templates: {
    sideEffect: "read",
    definition: GAMMA_LIST_TEMPLATES_DEFINITION,
    createTools: (context) => [createGammaListTemplatesTool(context)],
  },
};
