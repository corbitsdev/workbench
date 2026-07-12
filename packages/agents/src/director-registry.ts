import { type } from "arktype";
import { createDefaultDirector } from "@intx/inference";
import {
  createDirectorRegistry,
  defaultDirectorFactory,
  defineDirector,
  type DirectorRegistry,
} from "@intx/agent";
import { createPersonalAgentDirector, createTriageBudgetDirector } from "@workbench/myra";
import { createGranolaDirector } from "./granola/director";
import { createFirecrawlDirector } from "./firecrawl/director";
import {
  dynamicToolsDirector,
  createDynamicToolsDirector,
  hasDynamicToolsEnv,
  readDynamicEnv,
} from "./dynamic-tools";

const SenderFilterConfig = type({ allowedSenders: "string[]" });

export const personalAgentDirector = defineDirector<
  typeof SenderFilterConfig.infer
>({
  id: "@workbench/agents/personal-agent",
  configSchema: SenderFilterConfig,
  factory: (config, _env, agent) =>
    createPersonalAgentDirector(
      agent.systemPrompt,
      [...agent.toolDefinitions],
      config.allowedSenders,
    ),
});

export const granolaDirector = defineDirector<typeof SenderFilterConfig.infer>({
  id: "@workbench/agents/granola",
  configSchema: SenderFilterConfig,
  factory: (config, _env, agent) =>
    createGranolaDirector(
      agent.systemPrompt,
      [...agent.toolDefinitions],
      config.allowedSenders,
    ),
});

const EmptyConfig = type({});

export const firecrawlDirector = defineDirector<typeof EmptyConfig.infer>({
  id: "@workbench/agents/firecrawl",
  configSchema: EmptyConfig,
  factory: (_config, _env, agent) =>
    createFirecrawlDirector(agent.systemPrompt, [...agent.toolDefinitions]),
});

export const TRIAGE_BUDGET_DIRECTOR_ID = "@workbench/agents/triage-budget";

/**
 * Director for the ephemeral mailbox-triage Myra (CL-3384): construction-time
 * tool-call and token budget caps composed on top of whichever inner director
 * the session would otherwise get. Triage's advertised loadout can itself opt
 * into dynamic tool exposure (its persona includes `search_tools`/
 * `load_tools`), so this factory inspects `env` for the dynamic-tools env the
 * harness only sets when that happened — composing the budget wrapper around
 * `createDynamicToolsDirector` when present, or the interchange default
 * otherwise — rather than silently dropping dynamic tool behavior for every
 * triage session.
 */
export const triageBudgetDirector = defineDirector<typeof EmptyConfig.infer>({
  id: TRIAGE_BUDGET_DIRECTOR_ID,
  configSchema: EmptyConfig,
  factory: (_config, env, agent) => {
    const toolDefinitions = [...agent.toolDefinitions];
    const inner = hasDynamicToolsEnv(env)
      ? createDynamicToolsDirector(
          agent.systemPrompt,
          toolDefinitions,
          readDynamicEnv(env),
        )
      : createDefaultDirector(agent.systemPrompt, toolDefinitions);
    return createTriageBudgetDirector(agent.systemPrompt, toolDefinitions, inner);
  },
});

/**
 * Registry of every director a Workbench bundle ships, with the
 * interchange default as the fallback. The workflow-deploy capability
 * walk resolves each step agent's `director` ref against this registry
 * to emit the `director:<id>` grant; the sidecar harness uses it so an
 * agent definition that pins a Workbench director resolves at launch.
 * Agents that omit `director` fall back to the interchange default.
 */
export function createWorkbenchDirectorRegistry(): DirectorRegistry {
  return createDirectorRegistry({
    factories: [
      defaultDirectorFactory,
      personalAgentDirector.factory,
      granolaDirector.factory,
      firecrawlDirector.factory,
      dynamicToolsDirector.factory,
      triageBudgetDirector.factory,
    ],
    defaultId: defaultDirectorFactory.id,
  });
}
