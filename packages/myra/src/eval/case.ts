import { type } from "arktype";

/**
 * Myra prompt evaluation case format (CL-3193).
 *
 * Cases are fully synthetic: fixed user input, fixed context, fake
 * production-shaped tools, expected hard constraints on the tool/answer
 * trace, and optional soft answer assertions. No customer conversations,
 * credentials, or production tool output.
 */

export const EvalToolCallSchema = type({
  name: "string",
  "args?": "Record<string, unknown>",
});
export type EvalToolCall = typeof EvalToolCallSchema.infer;

export const EvalToolResultSchema = type({
  name: "string",
  result: "unknown",
});
export type EvalToolResult = typeof EvalToolResultSchema.infer;

/**
 * Hard constraints scored deterministically from a captured trace.
 * Soft answer checks (contains/notContains) are also deterministic string
 * matches — they are "answer assertions" in the ticket sense, not LLM judges.
 */
export const EvalConstraintsSchema = type({
  /** Tools that MUST appear in the trace (order-independent). */
  "mustCallTools?": "string[]",
  /** Tools that MUST NOT appear. */
  "mustNotCallTools?": "string[]",
  /** Exact tool-name sequence when order matters. */
  "toolSequence?": "string[]",
  /** Max number of tool calls allowed (inclusive). */
  "maxToolCalls?": "number.integer >= 0",
  /** When true, the final answer must be non-empty text. */
  "requireFinalAnswer?": "boolean",
  /** Substrings that must appear in the final answer (case-insensitive). */
  "answerContains?": "string[]",
  /** Substrings that must NOT appear in the final answer. */
  "answerNotContains?": "string[]",
  /**
   * When true, a final answer that claims success after a tool failure
   * is scored as a false-completion failure.
   */
  "forbidFalseCompletion?": "boolean",
});
export type EvalConstraints = typeof EvalConstraintsSchema.infer;

export const EvalFixedContextSchema = type({
  "operatorName?": "string",
  "operatorEmail?": "string",
  "memberInstructions?": "string",
  "model?": "string",
});
export type EvalFixedContext = typeof EvalFixedContextSchema.infer;

export const EvalCaseSchema = type({
  id: "string",
  title: "string",
  description: "string",
  /** Synthetic user message for this case. */
  userInput: "string",
  /** Fixed composition-time context (never customer data). */
  "context?": EvalFixedContextSchema,
  /**
   * Subset of tool names advertised for this case. When omitted, the
   * evaluator advertises the full synthetic platform surface.
   */
  "advertisedTools?": "string[]",
  /**
   * Fake tool results keyed by tool name. When the model (or a scripted
   * adapter) calls a tool, the runner returns this payload.
   */
  "toolFixtures?": EvalToolResultSchema.array(),
  constraints: EvalConstraintsSchema,
  tags: "string[]",
});
export type EvalCase = typeof EvalCaseSchema.infer;

/**
 * A captured single-run trace. Produced by the evaluator; scored by
 * `scoreTrace`. Fully synthetic when produced by the scripted adapter.
 */
export const EvalTraceSchema = type({
  caseId: "string",
  /** Exact system prompt handed to the model (provider-formatted). */
  systemPrompt: "string",
  /** Tool names advertised on the turn. */
  advertisedTools: "string[]",
  /** Ordered tool calls observed. */
  toolCalls: EvalToolCallSchema.array(),
  /** Final assistant text, or empty when the run produced none. */
  finalAnswer: "string",
  /** Inference retries observed (0 for scripted runs). */
  retries: "number.integer >= 0",
  usage: {
    inputTokens: "number.integer >= 0",
    outputTokens: "number.integer >= 0",
    "cacheReadTokens?": "number.integer >= 0",
  },
  /** Wall-clock ms for the run. */
  latencyMs: "number.integer >= 0",
  /** When true, a tool returned an error and the answer still claimed success. */
  "falseCompletion?": "boolean",
});
export type EvalTrace = typeof EvalTraceSchema.infer;

export const EvalConstraintResultSchema = type({
  name: "string",
  passed: "boolean",
  detail: "string",
});
export type EvalConstraintResult = typeof EvalConstraintResultSchema.infer;

export const EvalScoreSchema = type({
  caseId: "string",
  passed: "boolean",
  constraints: EvalConstraintResultSchema.array(),
  trace: EvalTraceSchema,
});
export type EvalScore = typeof EvalScoreSchema.infer;

export function parseEvalCase(raw: unknown): EvalCase {
  const parsed = EvalCaseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid eval case: ${parsed.summary}`);
  }
  return parsed;
}

export function parseEvalTrace(raw: unknown): EvalTrace {
  const parsed = EvalTraceSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid eval trace: ${parsed.summary}`);
  }
  return parsed;
}
