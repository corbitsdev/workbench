import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { TEMPLATE_DEFINITIONS, createTemplateTools } from "./templates";
import { THEME_DEFINITIONS, createThemeTools } from "./themes";
import {
  PRESENTATION_DEFINITIONS,
  createPresentationTools,
} from "./presentations";
import type { GammaToolsConfig } from "./shared";

export type { GammaFetch, GammaToolsConfig } from "./shared";
export { GAMMA_DEFAULT_BASE_URL } from "./shared";
export { type GammaTemplate } from "./templates";
export {
  GAMMA_LIST_TEMPLATES_DEFINITION,
  GAMMA_CREATE_FROM_TEMPLATE_DEFINITION,
  TEMPLATE_DEFINITIONS,
  createTemplateTools,
  generateFromTemplate,
} from "./templates";
export {
  GAMMA_LIST_THEMES_DEFINITION,
  THEME_DEFINITIONS,
  createThemeTools,
} from "./themes";
export {
  GAMMA_DUPLICATE_PRESENTATION_DEFINITION,
  PRESENTATION_DEFINITIONS,
  createPresentationTools,
} from "./presentations";

export const GAMMA_DEFINITIONS: ToolDefinition[] = [
  ...TEMPLATE_DEFINITIONS,
  ...THEME_DEFINITIONS,
  ...PRESENTATION_DEFINITIONS,
];

export function createGammaTools(config: GammaToolsConfig): AgentTool[] {
  return [
    ...createTemplateTools(config),
    ...createThemeTools(config),
    ...createPresentationTools(config),
  ];
}

function createGammaToolByName(
  config: GammaToolsConfig,
  name: string,
): AgentTool[] {
  return createGammaTools(config).filter(
    (tool) => tool.definition.name === name,
  );
}

// gamma_list_templates is registered as a ContextToolEntry in the hub (reads tenant DB),
// so it is excluded from GAMMA_HUB_TOOLS which are credential-backed Gamma API tools.
const GAMMA_HUB_DEFINITIONS = GAMMA_DEFINITIONS.filter(
  (d) => d.name !== "gamma_list_templates",
);

// GammaToolsConfig uses `baseUrl`; the hub registry passes `baseURL` (capital URL)
// to match the convention of other tool registries. The bridge below aligns them.
export const GAMMA_HUB_TOOLS = Object.fromEntries(
  GAMMA_HUB_DEFINITIONS.map((definition) => [
    definition.name,
    {
      definition,
      providerName: "gamma" as const,
      createTools: (config: {
        apiKey: string;
        baseURL?: string;
        fetcher?: GammaToolsConfig["fetcher"];
      }) =>
        createGammaToolByName(
          {
            apiKey: config.apiKey,
            ...(config.baseURL ? { baseUrl: config.baseURL } : {}),
            ...(config.fetcher ? { fetcher: config.fetcher } : {}),
          },
          definition.name,
        ),
    },
  ]),
);
