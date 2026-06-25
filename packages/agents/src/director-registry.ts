import { type } from "arktype";
import {
  createDirectorRegistry,
  defaultDirectorFactory,
  defineDirector,
  type DirectorRegistry,
} from "@intx/agent";
import { createPersonalAgentDirector } from "./personal-agent/director";
import { createGranolaDirector } from "./granola/director";
import { createFirecrawlDirector } from "./firecrawl/director";

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
    ],
    defaultId: defaultDirectorFactory.id,
  });
}
