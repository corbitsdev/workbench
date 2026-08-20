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

/** One agent definition's guided-capability state, as read off its
 * `workflow.json` (the same shape `GET /:definitionId/capabilities`
 * returns — see `targets/world-snapshot.ts`). */
export interface WorldAgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly toolPackagePins: readonly string[];
  readonly skills: readonly string[];
  readonly model: string | null;
}

/** One routine row. `trigger` is kept structural (not the
 * `@corbits/routines` arktype-validated type) so this package never
 * takes a hard dependency on that package's wire shape, only its
 * table. */
export interface WorldRoutine {
  readonly id: string;
  readonly name: string;
  readonly definitionId: string;
  readonly trigger: unknown;
  readonly deliveryWorkbenchId: string | null;
  readonly enabled: boolean;
}

/** One connected external system — an MCP server or another connector
 * — with whether its credential is currently active. */
export interface WorldConnection {
  readonly slug: string;
  readonly name: string;
  readonly url: string;
  readonly live: boolean;
}

/** One live `webhook_trigger` row (`@corbits/webhook-triggers`) — what
 * the code-review template's start-reviewing step creates per selected
 * repo, and what a fake `pull_request.opened` delivery fires. */
export interface WorldWebhookTrigger {
  readonly id: string;
  readonly name: string;
  readonly workflowDefinitionId: string;
  readonly enabled: boolean;
}

/** One call a recording MCP fake actually received — the eval
 * harness's "what did the outside world see" channel, folded into a
 * snapshot alongside the tenant's own state. Empty when no fake is
 * wired for a case. */
export interface FakeReceipt {
  readonly server: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

/** What actually exists in the tenant right now — not what the agent
 * said or called, but the state those calls produced. Captured once
 * per step, after that step's turn has landed (see runner.ts). */
export interface WorldSnapshot {
  readonly capturedAt: string;
  readonly agentDefinitions: readonly WorldAgentDefinition[];
  readonly routines: readonly WorldRoutine[];
  readonly connections: readonly WorldConnection[];
  readonly webhookTriggers: readonly WorldWebhookTrigger[];
  readonly fakeReceipts: readonly FakeReceipt[];
}

/** What a scorer sees: the full transcript so far, with `turnIndex`
 * naming which entry is the turn just played, and `world` — the
 * tenant's actual state as of that step. A `Target` with no
 * `snapshotWorld` capability yields an empty `WorldSnapshot` rather
 * than an absent field, so every scorer can read `ctx.world`
 * unconditionally. */
export interface ScorerContext {
  readonly transcript: readonly Turn[];
  readonly turnIndex: number;
  readonly world: WorldSnapshot;
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

/** A step whose human message is fixed in advance. `kind` defaults to
 * `"scripted"` — `defineEval` fills it in, so every existing case file
 * that writes a bare `{human, expect}` keeps working unchanged. */
export interface ScriptedEvalStep {
  readonly kind?: "scripted";
  readonly human: string;
  readonly expect: readonly Scorer[];
}

/** What a simulated-human persona knows going in. `goal` is the
 * persona's private objective — the opening message a scenario still
 * scripts; `knownFacts` are offered only when the agent's last reply
 * asks something that fairly maps to one ("answers what's asked,
 * volunteers nothing else"); `tone` is a voice note only, never a
 * behavioral instruction. */
export interface PersonaBrief {
  readonly name: string;
  readonly goal: string;
  readonly knownFacts: Readonly<Record<string, string>>;
  readonly tone?: string;
}

/** A step whose later human messages are generated turn-by-turn by a
 * persona reacting to the agent's replies, instead of being scripted in
 * advance. `maxTurns` is a hard bound on the sub-loop; `expect` scores
 * the last turn the loop produced. */
export interface PersonaEvalStep {
  readonly kind: "persona";
  readonly opening: string;
  readonly persona: PersonaBrief;
  readonly maxTurns: number;
  readonly expect: readonly Scorer[];
}

export type EvalStep = ScriptedEvalStep | PersonaEvalStep;

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
 * or a fake for unit-testing the runner itself (runner.test.ts).
 * `snapshotWorld` and `fireRoutine` are optional capabilities: not
 * every target can read the tenant's own tables or fire a routine
 * occurrence (a scripted-only fake `Target` can do neither), so
 * `runEval` guards `snapshotWorld` and falls back to an empty
 * `WorldSnapshot`, and a case that calls `fireRoutine` against a
 * `Target` missing it gets a loud, named error at the call site —
 * never a silent no-op. */
export interface Target {
  readonly configName: string;
  sendTurn(human: string): Promise<Turn>;
  snapshotWorld?(): Promise<WorldSnapshot>;
  fireRoutine?(routineId: string): Promise<Turn>;
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
