// Core shapes for the Myra eval library (CL-6143). Modeled after
// Mastra evals / LangChain evaluators: an eval is a hardcoded expected
// scenario (`EvalDefinition.steps`), each step a scripted human turn
// plus the `Scorer`s that grade what actually happened on that turn.
// Scorers are pure functions of a recorded `Turn` — no network, no
// clock — so they're unit-testable against hand-built transcripts;
// only `runEval` (via a `Target`) ever touches a real deployment.

/** One tool call a turn made, as recorded off the platform's own
 * inference_turn/turn_part tables (see targets/real-stack.ts for how a
 * live target observes these). */
export interface ToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly isError: boolean;
  readonly result: string;
}

/** One played turn: the human's message, the reply text, and every
 * tool call the run made while producing that reply. */
export interface Turn {
  readonly human: string;
  readonly replyText: string;
  readonly toolCalls: readonly ToolCall[];
}

/** What a scorer sees: the full transcript so far, with `turnIndex`
 * naming which entry is the turn just played. */
export interface ScorerContext {
  readonly transcript: readonly Turn[];
  readonly turnIndex: number;
}

export interface ScorerResult {
  readonly name: string;
  /** 0..1 — deterministic scorers return 0 or 1; `judge` may return a
   * graded score in between. */
  readonly score: number;
  readonly pass: boolean;
  readonly reason: string;
  /** Set when the scorer could not run (e.g. `judge` with no live
   * provider key) — never counted as a failure, reported separately. */
  readonly skipped?: boolean;
}

export type Scorer = (
  ctx: ScorerContext,
) => ScorerResult | Promise<ScorerResult>;

export interface EvalStep {
  readonly human: string;
  readonly expect: readonly Scorer[];
}

export interface EvalDefinition {
  readonly name: string;
  readonly description: string;
  readonly steps: readonly EvalStep[];
  /** Firm-memory entries to seed before the run starts, played as
   * "Please remember: <entry>" turns with no scorers before `steps`
   * runs — lets a step assume "Myra already knows X" without spending
   * a scripted step teaching her. */
  readonly memorySeed?: readonly string[];
}

/** Per-run configuration knobs a matrix varies. `toolPins` overrides
 * the assistant workflow's default tool-package pin list (name only —
 * version stays whatever's published); `systemPromptOverride` replaces
 * the deployed system prompt outright. */
export interface RunConfig {
  readonly name: string;
  readonly model?: string;
  readonly systemPromptOverride?: string;
  readonly toolPins?: readonly string[];
}

/** A target is anything that can play one scripted human turn and
 * report what happened — a real Myra deployment (targets/real-stack.ts)
 * or a fake for unit-testing the runner itself (runner.test.ts). */
export interface Target {
  readonly configName: string;
  sendTurn(human: string): Promise<Turn>;
  close(): Promise<void>;
}

export interface ScorerReport extends ScorerResult {
  readonly stepIndex: number;
}

export interface EvalStepRecord {
  readonly stepIndex: number;
  readonly turn: Turn;
  readonly scorerReports: ScorerReport[];
}

export interface EvalRunResult {
  readonly evalName: string;
  readonly configName: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly steps: EvalStepRecord[];
}
