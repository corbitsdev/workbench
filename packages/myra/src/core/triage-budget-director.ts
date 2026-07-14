import type { ReactorDirector, ToolDefinition } from "@intx/types/runtime";
import {
  createBudgetDirector,
  type BudgetDirectorOptions,
} from "./budget-director";

/**
 * Hard cap on tool calls in one ephemeral triage session (CL-3384). Triage is
 * unattended — no human watches a turn in progress — so the loop must be
 * bounded by construction rather than by trusting the model to stop.
 */
export const TRIAGE_MAX_TOOL_CALLS = 25;

/**
 * Hard cap on cumulative input/output tokens in one triage session. Read off
 * `ReactorState.tokenUsage`, which the reactor already maintains as a
 * running session total — no separate accounting needed.
 */
export const TRIAGE_MAX_INPUT_TOKENS = 1_000_000;
export const TRIAGE_MAX_OUTPUT_TOKENS = 1_000_000;

/**
 * Hard cap on `infer` actions in one triage session — a provider-independent
 * backstop for the case a provider reports no token usage and the model
 * loops infer→infer with no tool calls and no terminal reply, which the
 * tool-call and token caps above cannot see (both stay at zero forever in
 * that failure mode). 25 tool calls means up to 25 legitimate
 * tool.done→infer round-trips plus the opening and closing inference turns —
 * roughly 27 at the tool cap; 40 leaves comfortable headroom above that for
 * ordinary multi-turn reasoning before it is read as a stuck loop.
 */
export const TRIAGE_MAX_INFERENCE_TURNS = 40;

/**
 * Appended verbatim to the handoff once a session is steered to conclude.
 * Belt-and-braces: also appended directly to the `reply` action's own
 * content (see below) so the marker reaches the handoff even if the model's
 * final turn ignores the steering instruction.
 */
export const TRIAGE_BUDGET_STOP_MARKER =
  "Note: this triage session stopped at its safety budget (tool calls or token usage) before finishing normally. A human should review this message and take over from here.";

export const TRIAGE_BUDGET_PRESET: BudgetDirectorOptions = {
  maxToolCalls: TRIAGE_MAX_TOOL_CALLS,
  maxInputTokens: TRIAGE_MAX_INPUT_TOKENS,
  maxOutputTokens: TRIAGE_MAX_OUTPUT_TOKENS,
  maxInferenceTurns: TRIAGE_MAX_INFERENCE_TURNS,
  stopMarker: TRIAGE_BUDGET_STOP_MARKER,
};

/**
 * Triage preset of `createBudgetDirector` (CL-3384): construction-time
 * tool-call, token, and inference-turn budget caps composed on top of
 * whichever inner director the session would otherwise get.
 */
export function createTriageBudgetDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  innerDirector?: ReactorDirector,
): ReactorDirector {
  return createBudgetDirector(systemPrompt, toolDefinitions, {
    ...TRIAGE_BUDGET_PRESET,
    ...(innerDirector !== undefined ? { inner: innerDirector } : {}),
  });
}
