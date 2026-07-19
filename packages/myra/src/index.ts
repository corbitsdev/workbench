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
  PERSONAL_AGENT_TRIAGE_DEPLOY_PROMPT,
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
  myraSurfaceForTemplateKey,
  type MyraVariant,
  type MyraVariantProvider,
  type MyraVariantCostTier,
  type MyraVariantSummary,
} from "./core/variants";
export {
  STYLE_AXES,
  STYLE_AXIS_IDS,
  getStyleAxis,
  isStyleAxisOptionId,
  composeStyleOverlay,
  listStyleAxes,
  StyleAxisIdSchema,
  StyleAxisSummarySchema,
  StyleAxisOptionSummarySchema,
  type StyleAxisId,
  type StyleAxisOption,
  type StyleAxis,
  type StyleAxisSelections,
  type StyleAxisSummary,
  type StyleAxisOptionSummary,
} from "./core/style-axes";
export {
  MAX_PINNED_MYRA_SKILLS,
  filterPinnedEntriesForSurface,
  isPinnedSkillTriageRelevant,
  oneLineSkillDescription,
  renderPinnedSkillsSection,
  type MyraPromptSurface,
  type PinnedSkillIndexEntry,
} from "./core/pinned-skills";
export {
  getModelInferenceCapabilities,
  listKnownModelInferenceCapabilities,
  normalizeModelSlugForCapabilities,
  InferenceCapabilitiesResponseSchema,
  ModelInferenceCapabilitiesSchema,
  InferenceDialKindSchema,
  type InferenceDialKind,
  type ModelInferenceCapabilities,
} from "./core/inference-capabilities";
export {
  INFERENCE_PARAMS_ENV_KEY,
  readInferenceParamsFromEnv,
  readInferenceParamsForDirector,
  resolveInferenceOptionsFromDials,
  mergeInferenceOptions,
  type InferenceDialValue,
  type ResolvedInferenceDials,
} from "./core/inference-params";
export {
  wrapDirectorWithInferenceParams,
  wrapCapabilitiesWithInferenceParams,
} from "./core/inference-params-director";
export {
  buildInferenceParamsMarker,
  resolveInferenceParamsMarker,
  stripInferenceParamsMarker,
  InferenceParamsMarkerPayloadSchema,
  type InferenceParamsMarkerPayload,
} from "./core/inference-params-marker";
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
  PERSONAL_AGENT_IDENTITY_MARKER,
  hasPersonalAgentIdentityMarker,
  isPersonalAgentIdentityPrompt,
  withPersonalAgentIdentityMarker,
  stripPersonalAgentIdentityMarker,
} from "./core/personal-agent-identity";
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

// Prompt evaluation harness (CL-3193) — synthetic cases, deterministic
// scorer, scorecard. Live-model runs are an explicit admin command.
// composePersonalAgentEvalPrompt is exported from @workbench/myra/eval only
// so consumers that just need schemas/scorer do not pull the definition graph.
export {
  EvalCaseSchema,
  EvalConstraintsSchema,
  EvalFixedContextSchema,
  EvalScoreSchema,
  EvalToolCallSchema,
  EvalToolResultSchema,
  EvalTraceSchema,
  EvalConstraintResultSchema,
  EvalScorecardSchema,
  parseEvalCase,
  parseEvalTrace,
  V1_EVAL_CASES,
  evalCaseById,
  EVAL_PLATFORM_TOOLS,
  DEFAULT_EVAL_ADVERTISED_TOOL_NAMES,
  evalToolsByName,
  scoreTrace,
  buildScorecard,
  formatScorecardMarkdown,
  runEvalCase,
  createPassingScriptedAdapter,
  createFailingScriptedAdapter,
  composeStubEvalPrompt,
  type EvalCase,
  type EvalConstraints,
  type EvalFixedContext,
  type EvalScore,
  type EvalToolCall,
  type EvalToolResult,
  type EvalTrace,
  type EvalConstraintResult,
  type EvalScorecard,
  type ScorecardRun,
  type EvalModelAdapter,
  type EvalModelPlan,
  type ComposeEvalPrompt,
  type RunEvalCaseResult,
} from "./eval/index";
