import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { CAPTURE_DEFINITIONS, createCaptureTools } from "./capture";
import { SEARCH_DEFINITIONS, createSearchTools } from "./search";
import type {
  KnowledgeEngineFetch,
  KnowledgeEngineToolsConfig,
} from "./shared";

export type {
  KnowledgeEngineFetch,
  KnowledgeEngineToolsConfig,
} from "./shared";
export {
  SEARCH_COMPANY_KNOWLEDGE_DEFINITION,
  SEARCH_DEFINITIONS,
  createSearchTools,
  type KnowledgeSearchHit,
  type KnowledgeSearchResult,
} from "./search";
export {
  CAPTURE_TO_KNOWLEDGE_DEFINITION,
  CAPTURE_DEFINITIONS,
  createCaptureTools,
  type KnowledgeCaptureResult,
} from "./capture";

export const KNOWLEDGE_ENGINE_DEFINITIONS: ToolDefinition[] = [
  ...SEARCH_DEFINITIONS,
  ...CAPTURE_DEFINITIONS,
];

export function createKnowledgeEngineTools(
  config: KnowledgeEngineToolsConfig,
): AgentTool[] {
  return [...createSearchTools(config), ...createCaptureTools(config)];
}

function createKnowledgeEngineToolByName(
  config: KnowledgeEngineToolsConfig,
  name: string,
): AgentTool[] {
  // Build only the area the requested tool belongs to, rather than
  // constructing every tool and discarding all but one on each factory call.
  const tools =
    name === "capture_to_knowledge"
      ? createCaptureTools(config)
      : createSearchTools(config);
  return tools.filter((tool) => tool.definition.name === name);
}

/**
 * `tenantId`/`principalId` are optional on this entry point's config so the
 * type stays assignable to the hub tool-registry's generic
 * `createTools(config: { apiKey, baseURL }) => AgentTool[]` contract shared
 * by every credentialed tool package. In the real (sidecar) execution path
 * `interchange-tools.ts` always supplies both, resolved from the hub-RPC
 * context — never from agent-supplied arguments. A caller that invokes this
 * package outside that path without a tenantId fails loudly in
 * `resolveConfig` rather than silently guessing a tenant.
 */
export const KNOWLEDGE_ENGINE_HUB_TOOLS = Object.fromEntries(
  KNOWLEDGE_ENGINE_DEFINITIONS.map((definition) => [
    definition.name,
    {
      sideEffect:
        definition.name === "capture_to_knowledge"
          ? ("write" as const)
          : ("read" as const),
      definition,
      providerName: "corbits-knowledge-engine" as const,
      createTools: (config: {
        apiKey: string;
        baseURL: string;
        tenantId?: string;
        principalId?: string | null;
        fetcher?: KnowledgeEngineFetch;
      }) =>
        createKnowledgeEngineToolByName(
          config as KnowledgeEngineToolsConfig,
          definition.name,
        ),
    },
  ]),
);
