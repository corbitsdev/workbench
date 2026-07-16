import { createDefaultDirector } from "@workbench/inference";
import type {
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
} from "@intx/types/runtime";
import { wrapCapabilitiesWithInferenceParams } from "./inference-params-director";
import type { ResolvedInferenceDials } from "./inference-params";

const GENERIC_BUDGET_STOP_MARKER =
  "Note: this session stopped at its safety budget (tool calls, tokens, or inference turns) before finishing normally. A human should review this message and take over from here.";

/**
 * Construction-time budget caps a `createBudgetDirector` instance enforces:
 * a tool-call cap, cumulative input/output token caps, and a provider-
 * independent inference-turn cap (guards a no-tool, no-usage-reported
 * infer-loop that the tool/token caps alone cannot see). `stopMarker` lets a
 * caller brand the honest stop message; `inner` supplies the director to
 * wrap (defaults to the interchange default director for the agent's
 * `systemPrompt`/`toolDefinitions`).
 */
export type BudgetDirectorOptions = {
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxInferenceTurns: number;
  stopMarker?: string;
  inner?: ReactorDirector;
  /**
   * Rebase the budget on every `message.received`: tool-call and turn
   * counters reset to zero and the token caps become deltas from the usage
   * at that point. For a long-lived session that serves one budgeted
   * engagement per inbound mail (an invoked subagent receiving briefs),
   * this stops cumulative work across briefs from permanently capping the
   * session. Leave unset for one-shot sessions (triage), where lifetime
   * and engagement coincide.
   */
  resetPerMessage?: boolean;
  /** When set, merges member creative/thinking dials into each infer call. */
  inferenceDials?: ResolvedInferenceDials;
};

function countToolCalls(action: ReactorAction): number {
  return action.type === "execute_tools" ? action.calls.length : 0;
}

function countInferTurns(action: ReactorAction): number {
  return action.type === "infer" ? 1 : 0;
}

function toArray(actions: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(actions) ? actions : [actions];
}

type TokenBaseline = { input: number; output: number };

function isOverBudget(
  opts: BudgetDirectorOptions,
  state: ReactorState,
  toolCallTotal: number,
  inferenceTurnTotal: number,
  baseline: TokenBaseline,
): boolean {
  return (
    toolCallTotal >= opts.maxToolCalls ||
    state.tokenUsage.input - baseline.input >= opts.maxInputTokens ||
    state.tokenUsage.output - baseline.output >= opts.maxOutputTokens ||
    inferenceTurnTotal >= opts.maxInferenceTurns
  );
}

function buildSteerInstruction(stopMarker: string): string {
  return `\n\nYou have reached this session's safety budget (tool-call, token, or turn limit). No further tool calls are available to you. Conclude now using only what you have already gathered: give your best classification, priority, and draft if you have enough to do so, and say plainly what you could not finish. End your reply with exactly this line on its own: "${stopMarker}"`;
}

function steerToConclude(
  action: ReactorAction,
  stopMarker: string,
): ReactorAction {
  if (action.type !== "infer") return action;
  return {
    type: "infer",
    options: {
      ...action.options,
      tools: [],
      systemPrompt:
        (action.options?.systemPrompt ?? "") +
        buildSteerInstruction(stopMarker),
    },
  };
}

function appendStopMarker(
  action: ReactorAction,
  stopMarker: string,
): ReactorAction {
  if (action.type !== "reply") return action;
  if (action.content.includes(stopMarker)) return action;
  return {
    type: "reply",
    content: `${action.content}\n\n${stopMarker}`,
  };
}

/**
 * Grace window (in inference turns) past `maxInferenceTurns` before the
 * wrapper stops steering and forces the session to end outright. Steering
 * (dropping tools, appending an instruction) relies on the model honoring
 * the instruction on its very next turn; a model that ignores it and keeps
 * emitting bare `infer` actions must not be allowed to loop forever, so a
 * small grace margin bounds how many additional steered turns are tolerated
 * before the wrapper substitutes the reactor's own terminal sequence
 * (`checkpoint` + `reply` + `done`) — the same shape the default director
 * emits on `abort`.
 */
const BUDGET_INFERENCE_TURN_GRACE = 5;

/**
 * Wraps an inner director — the interchange default director unless the
 * caller supplies one — with hard, construction-time budget caps: a
 * tool-call cap, cumulative token caps, and a provider-independent
 * inference-turn cap. Below every cap this delegates entirely to the inner
 * director's decisions.
 *
 * Once a cap is reached, the wrapper stops offering tools on every
 * subsequent `infer` action and steers the turn to conclude via an appended
 * system-prompt instruction, appending an honest stop marker onto the
 * eventual `reply` action's content. Tool calls already proposed by the
 * model in the turn that crosses the cap are still executed — dropping tool
 * calls the model already emitted confuses the model or fails provider
 * validation (unanswered tool_use blocks).
 *
 * If the model keeps emitting bare `infer` actions past the inference-turn
 * cap's grace window (it never reports tokens and never stops on its own),
 * the wrapper substitutes the reactor's own terminal action sequence
 * (`checkpoint` + `reply` with the stop marker + `done`) instead of another
 * `infer`, so the session actually ends rather than looping forever.
 */
export function createBudgetDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  opts: BudgetDirectorOptions,
): ReactorDirector {
  const base =
    opts.inner ?? createDefaultDirector(systemPrompt, toolDefinitions);
  const stopMarker = opts.stopMarker ?? GENERIC_BUDGET_STOP_MARKER;
  const hardTurnCeiling = opts.maxInferenceTurns + BUDGET_INFERENCE_TURN_GRACE;
  let toolCallTotal = 0;
  let inferenceTurnTotal = 0;
  const baseline: TokenBaseline = { input: 0, output: 0 };

  return {
    async decide(
      event: ReactorInboundEvent,
      state: ReactorState,
      capabilities: ReactorCapabilities,
    ): Promise<ReactorAction | ReactorAction[]> {
      const effectiveCapabilities = wrapCapabilitiesWithInferenceParams(
        capabilities,
        opts.inferenceDials,
      );
      if (opts.resetPerMessage === true && event.type === "message.received") {
        toolCallTotal = 0;
        inferenceTurnTotal = 0;
        baseline.input = state.tokenUsage.input;
        baseline.output = state.tokenUsage.output;
      }

      const wasOverBudget = isOverBudget(
        opts,
        state,
        toolCallTotal,
        inferenceTurnTotal,
        baseline,
      );

      const actions = toArray(
        await base.decide(event, state, effectiveCapabilities),
      );

      for (const action of actions) {
        toolCallTotal += countToolCalls(action);
        inferenceTurnTotal += countInferTurns(action);
      }

      if (!wasOverBudget) return actions;

      const stillInferringPastGrace =
        inferenceTurnTotal > hardTurnCeiling &&
        actions.some((action) => action.type === "infer");

      if (stillInferringPastGrace) {
        return [
          capabilities.checkpoint("budget-inference-turns-exhausted"),
          capabilities.reply(stopMarker),
          capabilities.done(),
        ];
      }

      return actions.map((action) =>
        appendStopMarker(steerToConclude(action, stopMarker), stopMarker),
      );
    },
  };
}
