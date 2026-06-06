import type { ToolDefinition } from '@intx/types/runtime';
import { EXA_SEARCH_DEFINITION } from '@workbench/tools-exa';
import {
  GRANOLA_LIST_NOTES_DEFINITION,
  GRANOLA_GET_NOTE_DEFINITION,
} from '@workbench/tools-granola';

/**
 * Registry of known tool definitions that the hub can attach to an agent.
 * The sidecar must also register the corresponding tool runners; the hub
 * only controls which definitions the model sees.
 *
 * Definitions are imported from the tool packages themselves so there is a
 * single source of truth.
 */
export const KNOWN_TOOLS: Record<string, ToolDefinition> = {
  exa_search: EXA_SEARCH_DEFINITION,
  granola_list_notes: GRANOLA_LIST_NOTES_DEFINITION,
  granola_get_note: GRANOLA_GET_NOTE_DEFINITION,
};

/** Names of all tools registered in KNOWN_TOOLS. */
export const KNOWN_TOOL_NAMES: string[] = Object.keys(KNOWN_TOOLS);

/**
 * Build a ToolDefinition list from an array of tool names, filtering out
 * any names that are not in the known registry.
 */
export function buildToolDefinitions(names: string[]): ToolDefinition[] {
  return names
    .map((name) => KNOWN_TOOLS[name])
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
