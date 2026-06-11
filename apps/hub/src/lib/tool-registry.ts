import type { AgentTool } from '@intx/agent';
import type { DB } from '@intx/db';
import { createPosixTools } from '@intx/tools-posix';
import type { ToolDefinition } from '@intx/types/runtime';
import { AGENTS_HUB_TOOLS } from '@workbench/tools-agents';
import { EXA_HUB_TOOLS } from '@workbench/tools-exa';
import { FIRECRAWL_HUB_TOOLS } from '@workbench/tools-firecrawl';
import { GRANOLA_HUB_TOOLS } from '@workbench/tools-granola';
import { HACKERNEWS_HUB_TOOLS } from '@workbench/tools-hackernews';
import { GITHUB_HUB_TOOLS } from '@workbench/tools-github';
import { POLYMARKET_HUB_TOOLS } from '@workbench/tools-polymarket';
import { REDDIT_HUB_TOOLS } from '@workbench/tools-reddit';
import { SCRAPECREATORS_HUB_TOOLS } from '@workbench/tools-scrapecreators';
import { X_HUB_TOOLS } from '@workbench/tools-x';
import { ARTIFACT_HUB_TOOLS } from './artifact-tools';
import { DISPATCH_HUB_TOOLS } from '@workbench/tools-dispatch';
import { WRITE_ARTIFACT_HUB_TOOLS } from '../tools/write-artifact';
import { LAST30DAYS_CORE_HUB_TOOLS } from '../tools/last30days-core-tools';
import type { SessionService, EventCollectorRegistry, SidecarRouter } from '@intx/hub-sessions';

/**
 * All hub-managed tools, assembled from tool packages.
 *
 * To add a new tool: create a @workbench/tools-* package that exports a
 * *_HUB_TOOLS object and spread it here. No other hub or sidecar changes needed.
 */
export const KNOWN_TOOLS: Record<string, ToolEntry> = {
  ...EXA_HUB_TOOLS,
  ...FIRECRAWL_HUB_TOOLS,
  ...GRANOLA_HUB_TOOLS,
  ...HACKERNEWS_HUB_TOOLS,
  ...GITHUB_HUB_TOOLS,
  ...POLYMARKET_HUB_TOOLS,
  ...REDDIT_HUB_TOOLS,
  ...SCRAPECREATORS_HUB_TOOLS,
  ...X_HUB_TOOLS,
  ...ARTIFACT_HUB_TOOLS,
  ...DISPATCH_HUB_TOOLS,
  ...AGENTS_HUB_TOOLS,
  ...WRITE_ARTIFACT_HUB_TOOLS,
  ...LAST30DAYS_CORE_HUB_TOOLS,
};

export type CredentialToolEntry = {
  definition: ToolDefinition;
  providerName: string;
  createTools: (config: { apiKey: string; baseURL: string }) => AgentTool[];
};

export type ContextToolEntry = {
  definition: ToolDefinition;
  createTools: (context: {
    db: DB['db'];
    tenantId: string;
    principalId: string;
    agentId: string;
    sessionId: string;
    sessionService?: SessionService;
    eventCollectors?: EventCollectorRegistry;
    sidecarRouter?: SidecarRouter;
    buildToolDefinitions?: (names: string[]) => ToolDefinition[];
  }) => AgentTool[];
};

export type ToolEntry = CredentialToolEntry | ContextToolEntry;

export function isCredentialToolEntry(entry: ToolEntry): entry is CredentialToolEntry {
  return 'providerName' in entry;
}

/** Names of all tools registered in KNOWN_TOOLS. */
export const KNOWN_TOOL_NAMES: string[] = Object.keys(KNOWN_TOOLS);

export type ToolSummary = {
  name: string;
  providerName: string;
  description: string;
};

/** Summaries of all registered tools for client discovery. */
export const KNOWN_TOOL_SUMMARIES: ToolSummary[] = Object.entries(KNOWN_TOOLS).map(
  ([name, entry]) => ({
    name,
    providerName: isCredentialToolEntry(entry) ? entry.providerName : 'workbench',
    description: entry.definition.description ?? '',
  })
);

/**
 * Build a ToolDefinition list from an array of tool names, filtering out
 * any names not in the registry.
 */
const LOCAL_TOOL_DEFINITIONS: Record<string, ToolDefinition> = Object.fromEntries(
  createPosixTools({ cwd: process.cwd() }).definitions.map((definition) => [
    definition.name,
    definition,
  ])
);

export function buildToolDefinitions(names: string[]): ToolDefinition[] {
  return names
    .map((name) => KNOWN_TOOLS[name]?.definition ?? LOCAL_TOOL_DEFINITIONS[name])
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
