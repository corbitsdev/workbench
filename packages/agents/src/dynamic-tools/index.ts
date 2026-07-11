import { type } from "arktype";
import { defineDirector } from "@intx/agent";
import {
  DYNAMIC_TOOLS_ENV_KEY,
  type DynamicToolsEnv,
  type ToolCatalog,
} from "@workbench/tools-catalog";
import { PERSONAL_AGENT_NAME } from "@workbench/myra";
import { MYRA_TOOL_CATALOG } from "./catalog";
import { createDynamicToolsDirector } from "./director";

export { MYRA_TOOL_CATALOG } from "./catalog";
export { createDynamicToolsDirector } from "./director";

export const DYNAMIC_TOOLS_DIRECTOR_ID = "@workbench/agents/dynamic-tools";

/**
 * Static config for an agent that opts into dynamic tool exposure. Held on the
 * definition as the single source of truth for the catalog; the sidecar reads
 * it at launch to build the exposure state, wire the catalog tools, and select
 * the dynamic-tools director. Agents without a config are untouched — they
 * advertise every loaded tool exactly as before.
 */
export type DynamicToolConfig = {
  readonly catalog: ToolCatalog;
};

export const PERSONAL_AGENT_DYNAMIC_TOOLS: DynamicToolConfig = {
  catalog: MYRA_TOOL_CATALOG,
};

const PERSONAL_AGENT_PROMPT_MARKER = `You are ${PERSONAL_AGENT_NAME}, Chief of Staff`;

/**
 * Resolve the dynamic-tools config for an agent from its (marker-stripped)
 * system prompt. Only the personal agent (Myra) opts in today; every other
 * agent returns `undefined` and keeps full-advertisement behavior. Mirrors the
 * prompt-marker opt-in already used by `resolveMailOutboundLimit`, avoiding a
 * deploy-tree/DB schema change to carry a launch-time flag.
 */
export function resolveDynamicToolConfig(
  systemPrompt: string,
): DynamicToolConfig | undefined {
  if (systemPrompt.includes(PERSONAL_AGENT_PROMPT_MARKER)) {
    return PERSONAL_AGENT_DYNAMIC_TOOLS;
  }
  return undefined;
}

function readDynamicEnv(env: unknown): DynamicToolsEnv {
  const value = (env as Record<string, unknown>)[DYNAMIC_TOOLS_ENV_KEY];
  if (
    value === null ||
    typeof value !== "object" ||
    !("catalog" in value) ||
    !("exposure" in value)
  ) {
    throw new Error(
      `dynamic-tools director: env["${DYNAMIC_TOOLS_ENV_KEY}"] is missing or malformed`,
    );
  }
  return value as DynamicToolsEnv;
}

const EmptyConfig = type({});

export const dynamicToolsDirector = defineDirector<typeof EmptyConfig.infer>({
  id: DYNAMIC_TOOLS_DIRECTOR_ID,
  configSchema: EmptyConfig,
  factory: (_config, env, agent) =>
    createDynamicToolsDirector(
      agent.systemPrompt,
      agent.toolDefinitions,
      readDynamicEnv(env),
    ),
});
