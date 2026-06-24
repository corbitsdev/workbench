import type { AgentTool } from '@intx/agent';
import type { DB } from '@intx/db';
import { createPosixTools } from '@intx/tools-posix';
import { TOOL_DEFINITIONS as MAIL_TOOL_DEFINITIONS } from '@intx/tools-mail';
import type { ToolDefinition } from '@intx/types/runtime';
import { AGENTS_HUB_TOOLS } from '@workbench/tools-agents';
import { ATTIO_HUB_TOOLS } from '@workbench/tools-attio';
import { BLUESKY_HUB_TOOLS } from '@workbench/tools-bluesky';
import { EXA_HUB_TOOLS } from '@workbench/tools-exa';
import { LINEAR_HUB_TOOLS } from '@workbench/tools-linear';
import { FIRECRAWL_HUB_TOOLS } from '@workbench/tools-firecrawl';
import { GAMMA_HUB_TOOLS } from '@workbench/tools-gamma';
import { GRANOLA_HUB_TOOLS } from '@workbench/tools-granola';
import { HACKERNEWS_HUB_TOOLS } from '@workbench/tools-hackernews';
import { GITHUB_HUB_TOOLS } from '@workbench/tools-github';
import { POLYMARKET_HUB_TOOLS } from '@workbench/tools-polymarket';
import { REDDIT_HUB_TOOLS } from '@workbench/tools-reddit';
import { SCRAPECREATORS_HUB_TOOLS } from '@workbench/tools-scrapecreators';
import { X_HUB_TOOLS } from '@workbench/tools-x';
import { YOUTUBE_HUB_TOOLS } from '@workbench/tools-youtube';
import { ARTIFACT_HUB_TOOLS } from './artifact-tools';
import { DISPATCH_HUB_TOOLS } from '@workbench/tools-dispatch';
import { WRITE_ARTIFACT_HUB_TOOLS } from '../tools/write-artifact';
import { LIST_AGENTS_HUB_TOOLS } from '../tools/list-agents';
import { SKILLS_HUB_TOOLS } from '../tools/list-skills';
import { LAST30DAYS_CORE_HUB_TOOLS } from '../tools/last30days-core-tools';
import { GAMMA_LIST_TEMPLATES_HUB_TOOL } from '../tools/gamma-templates';
import type {
  SessionService,
  EventCollectorRegistry,
  SidecarRouter,
  RepoStore,
} from '@intx/hub-sessions';
import { canonicalizeToolNames, expandToolAliasGrants } from '@workbench/agents';

// Hub-session-token rail. Native-migrated tools (the first group) are
// here only as the coexistence fallback and are removed once the native
// path is verified on staging; hub-backed tools (the second group) have
// no tarball form and stay permanently. See docs/CREATING_AGENTS_AND_TOOLS.md.
export const KNOWN_TOOLS: Record<string, ToolEntry> = {
  // Native-migrated (coexistence fallback)
  ...ATTIO_HUB_TOOLS,
  ...BLUESKY_HUB_TOOLS,
  ...EXA_HUB_TOOLS,
  ...FIRECRAWL_HUB_TOOLS,
  ...LINEAR_HUB_TOOLS,
  // gamma_list_templates is a ContextToolEntry (reads tenant DB), not a credential tool.
  // The remaining GAMMA_HUB_TOOLS entries are credential tools that call the Gamma API.
  gamma_list_templates: GAMMA_LIST_TEMPLATES_HUB_TOOL,
  ...GAMMA_HUB_TOOLS,
  ...GRANOLA_HUB_TOOLS,
  ...HACKERNEWS_HUB_TOOLS,
  ...GITHUB_HUB_TOOLS,
  ...POLYMARKET_HUB_TOOLS,
  ...REDDIT_HUB_TOOLS,
  ...SCRAPECREATORS_HUB_TOOLS,
  ...X_HUB_TOOLS,
  ...YOUTUBE_HUB_TOOLS,
  ...LAST30DAYS_CORE_HUB_TOOLS,
  // Hub-backed (permanent; need hub db/services)
  ...ARTIFACT_HUB_TOOLS,
  ...DISPATCH_HUB_TOOLS,
  ...AGENTS_HUB_TOOLS,
  ...LIST_AGENTS_HUB_TOOLS,
  ...SKILLS_HUB_TOOLS,
  ...WRITE_ARTIFACT_HUB_TOOLS,
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
    repoStore?: RepoStore;
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
  [...createPosixTools({ cwd: process.cwd() }).definitions, ...MAIL_TOOL_DEFINITIONS].map(
    (definition) => [definition.name, definition]
  )
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
  const names = tools.filter((t): t is string => typeof t === 'string');
  return expandToolAliasGrants(canonicalizeToolNames(names));
}
