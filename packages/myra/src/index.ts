// Myra core — identity, tool loadout, memory wiring, director
export {
  buildPersonalAgentSystemPrompt,
  type PersonalAgentPromptOptions,
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
} from "./core/definition";
export { createPersonalAgentDirector } from "./core/director";
export {
  createTriageBudgetDirector,
  TRIAGE_MAX_TOOL_CALLS,
  TRIAGE_MAX_INPUT_TOKENS,
  TRIAGE_MAX_OUTPUT_TOKENS,
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
  type MailboxLoadout,
} from "./personas/mailbox";
