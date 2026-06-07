import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import { EXA_HUB_TOOLS } from '@workbench/tools-exa';
import { GRANOLA_HUB_TOOLS } from '@workbench/tools-granola';

/**
 * All hub-managed tools, assembled from tool packages.
 *
 * To add a new tool: create a @workbench/tools-* package that exports a
 * *_HUB_TOOLS object and spread it here. No other hub or sidecar changes needed.
 */
export const KNOWN_TOOLS: Record<string, ToolEntry> = {
  ...EXA_HUB_TOOLS,
  ...GRANOLA_HUB_TOOLS,
};

export type ToolEntry = {
  definition: ToolDefinition;
  providerName: string;
  createTools: (config: { apiKey: string; baseURL: string }) => AgentTool[];
};

/** Names of all tools registered in KNOWN_TOOLS. */
export const KNOWN_TOOL_NAMES: string[] = Object.keys(KNOWN_TOOLS);

/**
 * Build a ToolDefinition list from an array of tool names, filtering out
 * any names not in the registry.
 */
export function buildToolDefinitions(names: string[]): ToolDefinition[] {
  return names
    .map((name) => KNOWN_TOOLS[name]?.definition)
    .filter((def): def is ToolDefinition => def !== undefined);
}

/**
 * Extract the configured tool names from an agent's capabilities JSON bag.
 * Returns an empty array if capabilities is missing or malformed.
 */
export function getToolNamesFromCapabilities(capabilities: unknown): string[] {
  if (typeof capabilities !== 'object' || capabilities === null) return [];
  const tools = (capabilities as Record<string, unknown>)['tools'];
  if (!Array.isArray(tools)) return [];
  return tools.filter((t): t is string => typeof t === 'string');
}

/**
 * Extract the scheduler interval from an agent's capabilities JSON bag.
 * Returns undefined if not set — callers should only start a scheduler when
 * a value is present.
 */
export function getSchedulerIntervalMs(capabilities: unknown): number | undefined {
  if (typeof capabilities !== 'object' || capabilities === null) return undefined;
  const v = (capabilities as Record<string, unknown>)['schedulerIntervalMs'];
  return typeof v === 'number' && v > 0 ? v : undefined;
}
