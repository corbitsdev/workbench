// Shared constants
export {
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
  LLM_PROVIDER,
  LLM_WRITER_MODEL,
} from "./constants";
export {
  canonicalizeToolNames,
  canonicalizeStepToolName,
  canonicalizeAgentCapabilityNames,
  expandToolAliasGrants,
  toolPackagesForCapabilities,
  canonicalToolNamesForPackages,
  providersForToolPackages,
  toLlmToolName,
} from "./tool-names";
export { withCorbitsVocabulary } from "./corbits-vocabulary";
export {
  APPROVAL_GATED_TOOL_NAMES,
  INTERNAL_WRITE_EXCLUSIONS,
  NATIVE_APPROVAL_GATED_TOOL_NAMES,
  approvalGatedWriteNames,
  buildApprovalGatedToolNames,
} from "./tool-side-effects";
export { HUB_ONLY_TOOL_SIDE_EFFECTS } from "./hub-only-tool-side-effects";
export {
  deterministicToolStep,
  agentStep,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_TITLE_TAG,
  STEP_ARGMAP_TAG,
  STEP_NONFATAL_TAG,
  DETERMINISTIC_TOOL_KIND,
  ArgMap,
  ArgMapSpec,
  type DeterministicToolStepOpts,
  type AgentStepOpts,
} from "./deterministic-step";
export {
  classifyWorkflowSteps,
  countHumanGates,
  humanize,
  type FlowStepClass,
  type ClassifiedFlowStep,
  type DisplayFlowStep,
} from "./flow-classify";

// Personal agent (Myra) lives in @workbench/myra. Myra's chat prompt, tools,
// director, and seed-marker resolver are imported from there directly, not
// re-exported through this barrel.
export {
  DYNAMIC_TOOLS_DIRECTOR_ID,
  MYRA_TOOL_CATALOG,
  PERSONAL_AGENT_DYNAMIC_TOOLS,
  resolveDynamicToolConfig,
  createDynamicToolsDirector,
  dynamicToolsDirector,
  type DynamicToolConfig,
} from "./dynamic-tools";

// Loop agent
export { buildLoopAgentSystemPrompt } from "./loop/prompt";
export {
  LOOP_CREDENTIAL_REQUIREMENTS,
  LOOP_DEPLOY_PROMPT,
} from "./loop/definition";

// Granola agent
export { buildGranolaSystemPrompt } from "./granola/prompt";
export {
  GRANOLA_GRANT_REQUIREMENTS,
  GRANOLA_CREDENTIAL_REQUIREMENTS,
  GRANOLA_DEPLOY_PROMPT,
} from "./granola/definition";
export { createGranolaDirector } from "./granola/director";

// Firecrawl agent
export { buildFirecrawlSystemPrompt } from "./firecrawl/prompt";
export {
  FIRECRAWL_GRANT_REQUIREMENTS,
  FIRECRAWL_CREDENTIAL_REQUIREMENTS,
  FIRECRAWL_DEPLOY_PROMPT,
} from "./firecrawl/definition";
export { createFirecrawlDirector } from "./firecrawl/director";
export {
  createWorkbenchDirectorRegistry,
  personalAgentDirector,
  granolaDirector,
  firecrawlDirector,
  triageBudgetDirector,
  TRIAGE_BUDGET_DIRECTOR_ID,
  invokeBudgetDirector,
  INVOKE_BUDGET_DIRECTOR_ID,
  workflowStepBudgetDirector,
  WORKFLOW_STEP_BUDGET_DIRECTOR_ID,
} from "./director-registry";

// Compaction trigger director
export {
  wrapDirectorWithCompaction,
  COMPACTION_TRIGGER_THRESHOLD,
  type CompactionDirectorOptions,
  type CompactionTelemetryEvent,
} from "./compaction-director";

// Walter agent
export { buildWalterSystemPrompt } from "./walter/prompt";
export {
  WALTER_GRANT_REQUIREMENTS,
  WALTER_CREDENTIAL_REQUIREMENTS,
  WALTER_DEPLOY_PROMPT,
} from "./walter/definition";

// Lincoln agent
export { buildLincolnSystemPrompt } from "./lincoln/prompt";
export {
  LINCOLN_GRANT_REQUIREMENTS,
  LINCOLN_CREDENTIAL_REQUIREMENTS,
  LINCOLN_DEPLOY_PROMPT,
  LINCOLN_CAPABILITIES,
  LINCOLN_DEPLOY_DESCRIPTOR,
} from "./lincoln/definition";

// Summary agent — context compactor
export { buildSummaryAgentSystemPrompt } from "./summary-agent/prompt";
export {
  SUMMARY_AGENT_GRANT_REQUIREMENTS,
  SUMMARY_AGENT_CREDENTIAL_REQUIREMENTS,
  SUMMARY_AGENT_DEPLOY_PROMPT,
  SUMMARY_AGENT_MODEL_CONFIG,
  SUMMARY_AGENT_DEPLOY_DESCRIPTOR,
} from "./summary-agent/definition";

// Summarize compactor — context compaction strategy
export {
  createSummarizeCompactor,
  resolveCompactorSource,
  SUMMARIZE_COMPACTOR_NAME,
  SUMMARIZE_COMPACTOR_VERSION,
  SUMMARY_MODEL_ID,
  SUMMARY_MODEL_PROVIDER,
  RETAIN_RECENT_EXCHANGES,
  type CreateSummarizeCompactorOpts,
  type CompactorSourceResolution,
} from "./summarize-compactor";

// Hammy — the humanizer
export { buildHammySystemPrompt } from "./hammy-the-humanizer/prompt";
export {
  HAMMY_GRANT_REQUIREMENTS,
  HAMMY_CREDENTIAL_REQUIREMENTS,
  HAMMY_DEPLOY_PROMPT,
  HAMMY_CAPABILITIES,
} from "./hammy-the-humanizer/definition";

// Agent templates registry
export {
  AGENT_TEMPLATES,
  type AgentTemplate,
  isReapableAgentInstance,
} from "./templates";

// Model catalog derived from the agent templates (single source of truth)
export {
  AGENT_CATALOG,
  buildAgentCatalog,
  templateModelName,
  templateModelRequirements,
  type AgentCatalogSpec,
  type CatalogProviderSpec,
  type CatalogModelSpec,
  type CatalogOfferingSpec,
  type ModelPlugin,
} from "./catalog";

// Shared adapter
export { convertInstanceEvents } from "./adapter";
export { createPartAssembler, type PartAssembler } from "./part-assembler";
export { deriveAgentPhase, type AgentPhase } from "./agent-phase";
export {
  composeChatMessages,
  STREAMING_BUBBLE_ID,
  type ComposeChatInput,
  type ComposeChatResult,
} from "./chat-messages";

// Prompt builder
export {
  formatSection,
  buildSystemPrompt,
  buildContextBlock,
  HUMANIZER_SECTION,
} from "./prompt-builder";
export type { PromptSection, PromptFormat } from "./prompt-builder";

export {
  FREDDIE_DEPLOY_PROMPT,
  FREDDIE_GRANT_REQUIREMENTS,
  FREDDIE_CREDENTIAL_REQUIREMENTS,
  FREDDIE_CAPABILITIES,
  FREDDIE_MODEL_CONFIG,
  FREDDIE_DEPLOY_DESCRIPTOR,
} from "./freddie/definition";

export {
  FANNIE_DEPLOY_PROMPT,
  FANNIE_GRANT_REQUIREMENTS,
  FANNIE_CREDENTIAL_REQUIREMENTS,
  FANNIE_CAPABILITIES,
  FANNIE_MODEL_CONFIG,
  FANNIE_DEPLOY_DESCRIPTOR,
} from "./fannie/definition";
export {
  FILE_PARSER_NAME,
  FILE_PARSER_SYSTEM_PROMPT,
  FILE_PARSER_CREDENTIAL_REQUIREMENTS,
  FILE_PARSER_GRANT_REQUIREMENTS,
  FILE_PARSER_MODEL_CONFIG,
} from "./file-parser/definition";
export { AgentDeployDescriptor } from "./deploy-descriptor";
export {
  attachmentCapabilityForAgent,
  attachmentPolicyForAgent,
  acceptedMimeTypes,
  ATTACHMENT_CAPABILITIES,
  type AttachmentCapability,
  type AgentAttachmentPolicy,
} from "./attachment-capabilities";
