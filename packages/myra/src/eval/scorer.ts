import type {
  EvalCase,
  EvalConstraintResult,
  EvalScore,
  EvalTrace,
} from "./case";

function includesCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function scoreMustCallTools(
  caseDef: EvalCase,
  trace: EvalTrace,
): EvalConstraintResult | null {
  const required = caseDef.constraints.mustCallTools;
  if (required === undefined || required.length === 0) return null;
  const called = new Set(trace.toolCalls.map((c) => c.name));
  const missing = required.filter((name) => !called.has(name));
  return {
    name: "mustCallTools",
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? `called all required tools: ${required.join(", ")}`
        : `missing required tools: ${missing.join(", ")}`,
  };
}

function scoreMustNotCallTools(
  caseDef: EvalCase,
  trace: EvalTrace,
): EvalConstraintResult | null {
  const forbidden = caseDef.constraints.mustNotCallTools;
  if (forbidden === undefined || forbidden.length === 0) return null;
  const called = new Set(trace.toolCalls.map((c) => c.name));
  const hit = forbidden.filter((name) => called.has(name));
  return {
    name: "mustNotCallTools",
    passed: hit.length === 0,
    detail:
      hit.length === 0
        ? "no forbidden tools called"
        : `forbidden tools called: ${hit.join(", ")}`,
  };
}

function scoreToolSequence(
  caseDef: EvalCase,
  trace: EvalTrace,
): EvalConstraintResult | null {
  const expected = caseDef.constraints.toolSequence;
  if (expected === undefined || expected.length === 0) return null;
  const actual = trace.toolCalls.map((c) => c.name);
  // Sequence is a subsequence check: expected names appear in order,
  // possibly with other calls between — then tighten to exact prefix match
  // when lengths equal for multi-step cases that pin the full path.
  let ei = 0;
  for (const name of actual) {
    if (name === expected[ei]) ei += 1;
    if (ei === expected.length) break;
  }
  const passed = ei === expected.length;
  return {
    name: "toolSequence",
    passed,
    detail: passed
      ? `sequence satisfied: ${expected.join(" → ")}`
      : `expected sequence ${expected.join(" → ")}; got ${actual.join(" → ") || "(none)"}`,
  };
}

function scoreMaxToolCalls(
  caseDef: EvalCase,
  trace: EvalTrace,
): EvalConstraintResult | null {
  const max = caseDef.constraints.maxToolCalls;
  if (max === undefined) return null;
  const n = trace.toolCalls.length;
  return {
    name: "maxToolCalls",
    passed: n <= max,
    detail: n <= max ? `${n} ≤ ${max}` : `${n} tool calls exceeds max ${max}`,
  };
}

function scoreFinalAnswer(
  caseDef: EvalCase,
  trace: EvalTrace,
): EvalConstraintResult | null {
  if (caseDef.constraints.requireFinalAnswer !== true) return null;
  const ok = trace.finalAnswer.trim().length > 0;
  return {
    name: "requireFinalAnswer",
    passed: ok,
    detail: ok ? "non-empty final answer" : "missing final answer",
  };
}

function scoreAnswerContains(
  caseDef: EvalCase,
  trace: EvalTrace,
): EvalConstraintResult | null {
  const needles = caseDef.constraints.answerContains;
  if (needles === undefined || needles.length === 0) return null;
  const missing = needles.filter((n) => !includesCI(trace.finalAnswer, n));
  return {
    name: "answerContains",
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? "answer contains all required substrings"
        : `answer missing: ${missing.map((m) => JSON.stringify(m)).join(", ")}`,
  };
}

function scoreAnswerNotContains(
  caseDef: EvalCase,
  trace: EvalTrace,
): EvalConstraintResult | null {
  const needles = caseDef.constraints.answerNotContains;
  if (needles === undefined || needles.length === 0) return null;
  const hit = needles.filter((n) => includesCI(trace.finalAnswer, n));
  return {
    name: "answerNotContains",
    passed: hit.length === 0,
    detail:
      hit.length === 0
        ? "answer avoids forbidden substrings"
        : `answer contains forbidden: ${hit.map((m) => JSON.stringify(m)).join(", ")}`,
  };
}

function scoreFalseCompletion(
  caseDef: EvalCase,
  trace: EvalTrace,
): EvalConstraintResult | null {
  if (caseDef.constraints.forbidFalseCompletion !== true) return null;
  const flagged = trace.falseCompletion === true;
  return {
    name: "forbidFalseCompletion",
    passed: !flagged,
    detail: flagged
      ? "trace marked falseCompletion after a tool error"
      : "no false-completion flag",
  };
}

/**
 * Score a captured trace against a case's hard constraints.
 * Pure and deterministic — same inputs always produce the same result.
 */
export function scoreTrace(caseDef: EvalCase, trace: EvalTrace): EvalScore {
  if (trace.caseId !== caseDef.id) {
    throw new Error(
      `scoreTrace: trace.caseId "${trace.caseId}" does not match case "${caseDef.id}"`,
    );
  }
  const constraints = [
    scoreMustCallTools(caseDef, trace),
    scoreMustNotCallTools(caseDef, trace),
    scoreToolSequence(caseDef, trace),
    scoreMaxToolCalls(caseDef, trace),
    scoreFinalAnswer(caseDef, trace),
    scoreAnswerContains(caseDef, trace),
    scoreAnswerNotContains(caseDef, trace),
    scoreFalseCompletion(caseDef, trace),
  ].filter((r): r is EvalConstraintResult => r !== null);

  return {
    caseId: caseDef.id,
    passed: constraints.every((c) => c.passed),
    constraints,
    trace,
  };
}
