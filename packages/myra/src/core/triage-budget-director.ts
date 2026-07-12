import { createDefaultDirector } from "@intx/inference";
import type {
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
} from "@intx/types/runtime";

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
 * Appended verbatim to the handoff once a session is steered to conclude.
 * Belt-and-braces: also appended directly to the `reply` action's own
 * content (see below) so the marker reaches the handoff even if the model's
 * final turn ignores the steering instruction.
 */
export const TRIAGE_BUDGET_STOP_MARKER =
  "Note: this triage session stopped at its safety budget (tool calls or token usage) before finishing normally. A human should review this message and take over from here.";

const BUDGET_STEER_INSTRUCTION = `\n\nYou have reached this session's safety budget (tool-call or token limit). No further tool calls are available to you. Conclude now using only what you have already gathered: give your best classification, priority, and draft if you have enough to do so, and say plainly what you could not finish. End your reply with exactly this line on its own: "${TRIAGE_BUDGET_STOP_MARKER}"`;

function countToolCalls(action: ReactorAction): number {
  return action.type === "execute_tools" ? action.calls.length : 0;
}

function toArray(
  actions: ReactorAction | ReactorAction[],
): ReactorAction[] {
  return Array.isArray(actions) ? actions : [actions];
}

function isOverBudget(state: ReactorState, toolCallTotal: number): boolean {
  return (
    toolCallTotal >= TRIAGE_MAX_TOOL_CALLS ||
    state.tokenUsage.input >= TRIAGE_MAX_INPUT_TOKENS ||
    state.tokenUsage.output >= TRIAGE_MAX_OUTPUT_TOKENS
  );
}

function steerToConclude(action: ReactorAction): ReactorAction {
  if (action.type !== "infer") return action;
  return {
    type: "infer",
    options: {
      ...action.options,
      tools: [],
      systemPrompt:
        (action.options?.systemPrompt ?? "") + BUDGET_STEER_INSTRUCTION,
    },
  };
}

function appendStopMarker(action: ReactorAction): ReactorAction {
  if (action.type !== "reply") return action;
  if (action.content.includes(TRIAGE_BUDGET_STOP_MARKER)) return action;
  return {
    type: "reply",
    content: `${action.content}\n\n${TRIAGE_BUDGET_STOP_MARKER}`,
  };
}

/**
 * Wraps the interchange default director with hard, construction-time
 * budget caps for the ephemeral mailbox-triage Myra (CL-3384): a tool-call
 * cap and cumulative token caps. Below the caps this delegates entirely to
 * the default director, so ordinary triage sessions are unaffected.
 *
 * Once a cap is reached, the wrapper stops offering tools on every
 * subsequent `infer` action (shrinks `options.tools` to `[]`) and steers the
 * turn to conclude via an appended system-prompt instruction. It also
 * appends an honest stop marker directly onto the eventual `reply` action's
 * content, so the handoff states plainly that triage stopped at its budget
 * even if the model's own text does not carry the instructed line.
 *
 * Tool calls already proposed by the model in the turn that crosses the cap
 * are still executed — dropping tool calls the model already emitted
 * confuses the model or fails provider validation (unanswered tool_use
 * blocks), per the default director's own `afterInferenceDone` contract
 * notes. The cap therefore bites on the *next* composition, not
 * mid-execution.
 */
export function createTriageBudgetDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
): ReactorDirector {
  const base = createDefaultDirector(systemPrompt, toolDefinitions);
  let toolCallTotal = 0;

  return {
    async decide(
      event: ReactorInboundEvent,
      state: ReactorState,
      capabilities: ReactorCapabilities,
    ): Promise<ReactorAction | ReactorAction[]> {
      const wasOverBudget = isOverBudget(state, toolCallTotal);

      const actions = toArray(await base.decide(event, state, capabilities));

      for (const action of actions) {
        toolCallTotal += countToolCalls(action);
      }

      if (!wasOverBudget) return actions;

      return actions.map((action) =>
        appendStopMarker(steerToConclude(action)),
      );
    },
  };
}
