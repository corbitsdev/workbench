export { LOOP_DEPLOY_PROMPT, LOOP_DEPLOY_DESCRIPTOR } from "./loop/definition";
export {
  GRANOLA_DEPLOY_PROMPT,
  GRANOLA_CAPABILITIES,
  GRANOLA_DEPLOY_DESCRIPTOR,
} from "./granola/definition";
export {
  FIRECRAWL_DEPLOY_PROMPT,
  FIRECRAWL_CAPABILITIES,
  FIRECRAWL_DEPLOY_DESCRIPTOR,
} from "./firecrawl/definition";
export {
  WALTER_DEPLOY_PROMPT,
  WALTER_CAPABILITIES,
  WALTER_DEPLOY_DESCRIPTOR,
} from "./walter/definition";
export {
  friendlyToolSummary,
  friendlyToolSummaryKnown,
  friendlyToolResult,
  summarizeToolCalls,
  toolOperationKey,
  isCatalogMetaTool,
  isExternalIntegrationTool,
  integrationToolProviderKey,
  isToolSummaryStyle,
  TOOL_SUMMARY_STYLES,
  TOOL_SUMMARY_STYLE_LABELS,
  TOOL_SUMMARY_PREVIEW_CALLS,
  type ToolSummaryStyle,
} from "./friendly-tool-summary";
export { convertInstanceEvents } from "./adapter";
export { createPartAssembler, type PartAssembler } from "./part-assembler";
export { deriveAgentPhase, type AgentPhase } from "./agent-phase";
export {
  createAgentPhaseTracker,
  type AgentPhaseTracker,
} from "./agent-phase-tracker";
export {
  createRunBusyTracker,
  type RunBusyTracker,
} from "./run-busy-tracker";
export {
  composeChatMessages,
  STREAMING_BUBBLE_ID,
  reconstructDroppedTurnEvents,
  mergeReconstructedTurns,
  type ComposeChatInput,
  type ComposeChatResult,
} from "./chat-messages";
export { buildContextBlock } from "./prompt-builder";
export { AgentDeployDescriptor } from "./deploy-descriptor";

import { LOOP_DEPLOY_DESCRIPTOR } from "./loop/definition";
import { GRANOLA_DEPLOY_DESCRIPTOR } from "./granola/definition";
import { FIRECRAWL_DEPLOY_DESCRIPTOR } from "./firecrawl/definition";
import { WALTER_DEPLOY_DESCRIPTOR } from "./walter/definition";
import type { AgentDeployDescriptor } from "./deploy-descriptor";

/** All premade agents available for deployment from the UI. */
export const PREMADE_AGENTS: AgentDeployDescriptor[] = [
  LOOP_DEPLOY_DESCRIPTOR,
  GRANOLA_DEPLOY_DESCRIPTOR,
  FIRECRAWL_DEPLOY_DESCRIPTOR,
  WALTER_DEPLOY_DESCRIPTOR,
];

export {
  attachmentCapabilityForAgent,
  attachmentPolicyForAgent,
  acceptedMimeTypes,
  ATTACHMENT_CAPABILITIES,
  type AttachmentCapability,
  type AgentAttachmentPolicy,
} from "./attachment-capabilities";
