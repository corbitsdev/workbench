import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { jsonResult, type LinearToolsConfig, validateConfig } from "./shared";

export type LinearHandler = (
  config: LinearToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export function buildLinearHandler(
  config: LinearToolsConfig,
  handler: LinearHandler,
) {
  return async (args: Record<string, unknown>, signal: AbortSignal) =>
    jsonResult(await handler(config, args, signal));
}

export function createLinearToolFor(
  config: LinearToolsConfig,
  definition: ToolDefinition,
  handler: LinearHandler,
): AgentTool[] {
  validateConfig(config);
  return [
    {
      kind: "string",
      definition,
      handler: buildLinearHandler(config, handler),
    },
  ];
}

export type LinearSideEffect = "read" | "write";

export type LinearHubToolEntry = {
  sideEffect: LinearSideEffect;
  definition: ToolDefinition;
  providerName: "linear";
  handler: LinearHandler;
  createTools: (config: { apiKey: string; baseURL: string }) => AgentTool[];
};

export function linearHubEntry(
  definition: ToolDefinition,
  handler: LinearHandler,
  sideEffect: LinearSideEffect,
): LinearHubToolEntry {
  return {
    sideEffect,
    definition,
    providerName: "linear",
    handler,
    createTools: (config) =>
      createLinearToolFor(
        config.baseURL.length > 0
          ? { apiKey: config.apiKey, baseUrl: config.baseURL }
          : { apiKey: config.apiKey },
        definition,
        handler,
      ),
  };
}
