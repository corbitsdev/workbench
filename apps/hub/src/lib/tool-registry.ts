import type { AgentTool } from "@intx/agent";
import type { HubDb } from "../db";
import type { HeartbeatMemberIdentity } from "./heartbeat-trigger-payload";
import { createPosixTools } from "@intx/tools-posix";
import { TOOL_DEFINITIONS as MAIL_TOOL_DEFINITIONS } from "@intx/tools-mail";
import type { ToolDefinition } from "@intx/types/runtime";
import { AGENTS_HUB_TOOLS } from "@workbench/tools-agents";
import { ATTIO_HUB_TOOLS } from "@workbench/tools-attio";
import { BLUESKY_HUB_TOOLS } from "@workbench/tools-bluesky";
import { EXA_HUB_TOOLS } from "@workbench/tools-exa";
import { LINEAR_HUB_TOOLS } from "@workbench/tools-linear";
import { NOTION_HUB_TOOLS } from "@workbench/tools-notion";
import { KNOWLEDGE_ENGINE_HUB_TOOLS } from "@workbench/tools-corbits-knowledge-engine";
import { FIRECRAWL_HUB_TOOLS } from "@workbench/tools-firecrawl";
import { GAMMA_HUB_TOOLS } from "@workbench/tools-gamma";
import {
  GRANOLA_HUB_TOOLS,
  GRANOLA_WORKFLOW_HUB_TOOLS,
} from "@workbench/tools-granola";
import { HACKERNEWS_HUB_TOOLS } from "@workbench/tools-hackernews";
import { GITHUB_HUB_TOOLS } from "@workbench/tools-github";
import { POLYMARKET_HUB_TOOLS } from "@workbench/tools-polymarket";
import { REDDIT_HUB_TOOLS } from "@workbench/tools-reddit";
import { SCRAPECREATORS_HUB_TOOLS } from "@workbench/tools-scrapecreators";
import { SLACK_HUB_TOOLS } from "@workbench/tools-slack";
import { SUMBLE_HUB_TOOLS } from "@workbench/tools-sumble";
import { VERCEL_HUB_TOOLS } from "@workbench/tools-vercel";
import { X_HUB_TOOLS } from "@workbench/tools-x";
import { YOUTUBE_HUB_TOOLS } from "@workbench/tools-youtube";
import { ARTIFACT_HUB_TOOLS } from "./artifact-tools";
import { FILEPARSER_HUB_TOOLS } from "./file-parser-tools";
import { MEMORY_HUB_TOOLS } from "./memory-tools";
import { DISPATCH_HUB_TOOLS } from "@workbench/tools-dispatch";
import { WRITE_ARTIFACT_HUB_TOOLS } from "../tools/write-artifact";
import { LIST_AGENTS_HUB_TOOLS } from "../tools/list-agents";
import { SEARCH_AGENTS_HUB_TOOLS } from "../tools/search-agents";
import { INVOKE_AGENT_HUB_TOOLS } from "../tools/invoke-agent";
import { IDENTITY_HUB_TOOLS } from "../tools/identity";
import { INBOX_DELIVER_BATCH_HUB_TOOLS } from "../tools/inbox-deliver-batch";
import { SKILLS_HUB_TOOLS } from "../tools/list-skills";
import { GAMMA_TEMPLATES_HUB_TOOLS } from "../tools/gamma-templates";
import { AB_COMPARE_HUB_TOOLS } from "../tools/ab-compare-tools";
import { LAST30DAYS_CORE_HUB_TOOLS } from "../tools/last30days-core-tools";
import { PROSPECT_ENGINE_HUB_TOOLS } from "../tools/prospect-engine-tools";
import { TASK_HUB_TOOLS } from "../tools/task-tools";
import { VERCEL_DEPLOY_ARTIFACT_HUB_TOOLS } from "../tools/vercel-deploy-artifact";
import { GRANOLA_CALL_HUB_TOOLS } from "../tools/granola-call-tools";
import type {
  SessionService,
  EventCollectorRegistry,
  SidecarRouter,
  RepoStore,
  AssetService,
} from "@workbench/hub-sessions";
import type { CryptoProvider } from "@intx/types/runtime";
import type {
  EnsureDeploymentRoutableFn,
  ProvisionRunDeploymentFn,
} from "../routes/workflow-runs";
import { WORKFLOWS_HUB_TOOLS } from "../tools/workflow-run-tools";
import {
  canonicalizeToolNames,
  expandToolAliasGrants,
} from "@workbench/agents";
import type { AnalyticsSubscriber } from "@workbench/analytics";

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
  ...NOTION_HUB_TOOLS,
  ...KNOWLEDGE_ENGINE_HUB_TOOLS,
  // GAMMA_HUB_TOOLS carries only the credential tools that call the Gamma API;
  // gamma_list_templates executes via HUB_BACKED_TOOLS and is listed here (like
  // every other hub-backed tool) so the Tools gallery and search still show it.
  ...GAMMA_HUB_TOOLS,
  ...GAMMA_TEMPLATES_HUB_TOOLS,
  ...GRANOLA_HUB_TOOLS,
  ...GRANOLA_WORKFLOW_HUB_TOOLS,
  ...HACKERNEWS_HUB_TOOLS,
  ...GITHUB_HUB_TOOLS,
  ...POLYMARKET_HUB_TOOLS,
  ...REDDIT_HUB_TOOLS,
  ...SCRAPECREATORS_HUB_TOOLS,
  ...SLACK_HUB_TOOLS,
  ...SUMBLE_HUB_TOOLS,
  ...VERCEL_HUB_TOOLS,
  ...VERCEL_DEPLOY_ARTIFACT_HUB_TOOLS,
  ...X_HUB_TOOLS,
  ...YOUTUBE_HUB_TOOLS,
  ...AB_COMPARE_HUB_TOOLS,
  ...LAST30DAYS_CORE_HUB_TOOLS,
  ...PROSPECT_ENGINE_HUB_TOOLS,
  // Hub-backed (permanent; need hub db/services)
  ...ARTIFACT_HUB_TOOLS,
  ...FILEPARSER_HUB_TOOLS,
  ...MEMORY_HUB_TOOLS,
  ...DISPATCH_HUB_TOOLS,
  ...INVOKE_AGENT_HUB_TOOLS,
  ...AGENTS_HUB_TOOLS,
  ...LIST_AGENTS_HUB_TOOLS,
  ...SEARCH_AGENTS_HUB_TOOLS,
  ...IDENTITY_HUB_TOOLS,
  ...INBOX_DELIVER_BATCH_HUB_TOOLS,
  ...SKILLS_HUB_TOOLS,
  ...WRITE_ARTIFACT_HUB_TOOLS,
  ...WORKFLOWS_HUB_TOOLS,
  ...TASK_HUB_TOOLS,
  ...GRANOLA_CALL_HUB_TOOLS,
};

export type CredentialToolEntry = {
  sideEffect: "read" | "write";
  definition: ToolDefinition;
  providerName: string;
  createTools: (config: { apiKey: string; baseURL: string }) => AgentTool[];
};

export type ContextToolEntry = {
  sideEffect: "read" | "write";
  definition: ToolDefinition;
  createTools: (context: {
    db: HubDb;
    tenantId: string;
    principalId: string;
    agentId: string;
    sessionId: string;
    sessionService?: SessionService;
    eventCollectors?: EventCollectorRegistry;
    sidecarRouter?: SidecarRouter;
    // Sink for hub-side, in-process one-shot inference usage (File Parser,
    // CL-2801) so its tokens land in analytics_event attributed to the caller.
    analytics?: AnalyticsSubscriber;
    repoStore?: RepoStore;
    assetService?: AssetService;
    buildToolDefinitions?: (names: string[]) => ToolDefinition[];
    // Workflow-exec wiring for the workflow-run tools (CL-2678); pre-bound in
    // index.ts alongside the /workflow-exec routes so both rails share the
    // same start/resume service.
    cryptoProvider?: CryptoProvider;
    deploymentDomain?: string;
    provisionRunDeployment?: ProvisionRunDeploymentFn;
    ensureDeploymentRoutable?: EnsureDeploymentRoutableFn;
    // Shared with the /workflow-exec routes so `workflow_start` gets
    // the same trigger-payload enrichment as the generic HTTP start route.
    resolveUserIdentity?: (
      principalId: string,
    ) => Promise<HeartbeatMemberIdentity>;
  }) => AgentTool[];
};

export type ToolEntry = CredentialToolEntry | ContextToolEntry;

export function isCredentialToolEntry(
  entry: ToolEntry,
): entry is CredentialToolEntry {
  return "providerName" in entry;
}

/** Names of all tools registered in KNOWN_TOOLS. */
export const KNOWN_TOOL_NAMES: string[] = Object.keys(KNOWN_TOOLS);

export type ToolSummary = {
  name: string;
  providerName: string;
  description: string;
};

/** Summaries of all registered tools for client discovery. */
export const KNOWN_TOOL_SUMMARIES: ToolSummary[] = Object.entries(
  KNOWN_TOOLS,
).map(([name, entry]) => ({
  name,
  providerName: isCredentialToolEntry(entry) ? entry.providerName : "workbench",
  description: entry.definition.description ?? "",
}));

/**
 * Build a ToolDefinition list from an array of tool names, filtering out
 * any names not in the registry.
 */
const LOCAL_TOOL_DEFINITIONS: Record<string, ToolDefinition> =
  Object.fromEntries(
    [
      ...createPosixTools({ cwd: process.cwd() }).definitions,
      ...MAIL_TOOL_DEFINITIONS,
    ].map((definition) => [definition.name, definition]),
  );

export function buildToolDefinitions(names: string[]): ToolDefinition[] {
  return names
    .map(
      (name) => KNOWN_TOOLS[name]?.definition ?? LOCAL_TOOL_DEFINITIONS[name],
    )
    .filter((def): def is ToolDefinition => def !== undefined);
}

/**
 * Extract the configured tool names from an agent's capabilities JSON bag.
 * Returns an empty array if capabilities is missing or malformed.
 */
export function getToolNamesFromCapabilities(capabilities: unknown): string[] {
  if (typeof capabilities !== "object" || capabilities === null) return [];
  const tools = (capabilities as Record<string, unknown>)["tools"];
  if (!Array.isArray(tools)) return [];
  const names = tools.filter((t): t is string => typeof t === "string");
  return expandToolAliasGrants(canonicalizeToolNames(names));
}
