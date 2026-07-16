// Myra core — identity, tool loadout, memory wiring, director
export {
  buildPersonalAgentSystemPrompt,
  type PersonalAgentPromptOptions,
  OperatorProfileSchema,
  type OperatorProfile,
  PERSONAL_AGENT_PROMPT_VERSION,
  renderMemberInstructionsSection,
  MemberInstructionsSchema,
  type MemberInstructions,
} from "./core/prompt";
export {
  buildPersonalAgentGrantRequirements,
  PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
  PERSONAL_AGENT_DEPLOY_PROMPT,
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_PLATFORM_TOOLS,
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_MODEL_CONFIG,
  PERSONAL_AGENT_TRIAGE_NAME,
  PERSONAL_AGENT_TRIAGE_MODEL_CONFIG,
  PERSONAL_AGENT_PROMPT_FORMAT,
} from "./core/definition";
export {
  MYRA_VARIANTS,
  MyraVariantKind,
  MyraVariantSummarySchema,
  listMyraVariants,
  getMyraVariant,
  isMyraVariantId,
  defaultMyraVariant,
  resolveMyraVariant,
  type MyraVariant,
  type MyraVariantProvider,
  type MyraVariantCostTier,
  type MyraVariantSummary,
} from "./core/variants";
export { createPersonalAgentDirector } from "./core/director";
export {
  createBudgetDirector,
  type BudgetDirectorOptions,
} from "./core/budget-director";
export {
  createTriageBudgetDirector,
  TRIAGE_BUDGET_PRESET,
  TRIAGE_MAX_TOOL_CALLS,
  TRIAGE_MAX_INPUT_TOKENS,
  TRIAGE_MAX_OUTPUT_TOKENS,
  TRIAGE_MAX_INFERENCE_TURNS,
  TRIAGE_BUDGET_STOP_MARKER,
} from "./core/triage-budget-director";
export {
  PERSONAL_AGENT_SEED_FILES,
  parseSeedMarker,
  resolveSeedMarker,
  stripSeedMarker,
  hasSeedMarker,
  type SeedWorkspaceFile,
  type SeedMarkerParse,
  type SeedMarkerResolution,
} from "./core/seed-files";

// Mailbox triage loadout — prompt + read-only tool posture mounted on an
// ephemeral, per-item Myra triage session.
export {
  resolveMailboxLoadout,
  isTriageSessionPrompt,
  type MailboxLoadout,
} from "./personas/mailbox";

// Mailbox triage business rules — eligibility, handoff subject/message-key
// scheme, and prompt composition for the hub's ephemeral triage session.
export {
  TRIAGE_TEMPLATE_KEY,
  isSystemSenderAddress,
  isBounceSenderAddress,
  isTriageHandoffSubject,
  triageHandoffSubject,
  triageMessageKey,
  composeTriagePromptMessage,
  type TriagePromptMessageInput,
} from "./personas/mailbox-triage-policy";

export {
  createInvokeBudgetDirector,
  INVOKE_BUDGET_PRESET,
  INVOKE_MAX_TOOL_CALLS,
  INVOKE_MAX_INPUT_TOKENS,
  INVOKE_MAX_OUTPUT_TOKENS,
  INVOKE_MAX_INFERENCE_TURNS,
  INVOKE_BUDGET_STOP_MARKER,
} from "./core/invoke-budget-director";

// Subagent-invocation policy — the member_agent_instance template key an
// invoked subagent instance is attributed under, and the prompt-marker
// convention the sidecar harness selects the invoke budget director from.
export {
  INVOKE_TEMPLATE_KEY,
  withInvokeSessionMarker,
  isInvokeSessionPrompt,
  isPersonalAgentDefinitionName,
} from "./personas/invoke-policy";
