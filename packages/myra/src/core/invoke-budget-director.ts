import type { ReactorDirector, ToolDefinition } from "@intx/types/runtime";
import {
  createBudgetDirector,
  type BudgetDirectorOptions,
} from "./budget-director";

/**
 * Hard cap on tool calls in one invoked-subagent session. An invoked
 * subagent runs unattended — nobody watches its turn in progress, the same
 * shape of risk the triage budget director bounds — so it needs the same
 * provider-independent ceiling rather than trusting the model to stop on its
 * own. Sized above the triage preset: a research-style delegated brief
 * legitimately does more grounding (searches, fetches) than a single triage
 * classification turn.
 */
export const INVOKE_MAX_TOOL_CALLS = 40;
export const INVOKE_MAX_INPUT_TOKENS = 1_500_000;
export const INVOKE_MAX_OUTPUT_TOKENS = 1_500_000;
export const INVOKE_MAX_INFERENCE_TURNS = 60;

export const INVOKE_BUDGET_STOP_MARKER =
  "Note: this invoked session stopped at its safety budget (tool calls or token usage) before finishing normally. Report back what was completed and that the budget was hit.";

export const INVOKE_BUDGET_PRESET: BudgetDirectorOptions = {
  maxToolCalls: INVOKE_MAX_TOOL_CALLS,
  maxInputTokens: INVOKE_MAX_INPUT_TOKENS,
  maxOutputTokens: INVOKE_MAX_OUTPUT_TOKENS,
  maxInferenceTurns: INVOKE_MAX_INFERENCE_TURNS,
  stopMarker: INVOKE_BUDGET_STOP_MARKER,
  // An invoked subagent session is long-lived and reused across briefs
  // (invoke_agent reuses a routable instance); each mailed brief is one
  // budgeted engagement, so the caps rebase per message rather than
  // permanently capping the session once cumulative work crosses them.
  resetPerMessage: true,
};

/**
 * Invoke preset of `createBudgetDirector`: construction-time tool-call,
 * token, and inference-turn budget caps composed on top of whichever inner
 * director the session would otherwise get. Mirrors
 * `createTriageBudgetDirector`.
 */
export function createInvokeBudgetDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  innerDirector?: ReactorDirector,
): ReactorDirector {
  return createBudgetDirector(systemPrompt, toolDefinitions, {
    ...INVOKE_BUDGET_PRESET,
    ...(innerDirector !== undefined ? { inner: innerDirector } : {}),
  });
}
