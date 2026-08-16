// Composable, pure scoring functions over a recorded `Turn` (see
// ../types.ts) — the same `{score, pass, reason}` contract for a
// deterministic check and an LLM-judge check alike. No hub, no
// network, no clock in any scorer but `judge`, so every one of these
// is unit-testable on hand-built transcripts (see scorers.test.ts)
// without booting the real stack.

import type { ScorerContext, ScorerResult, ToolCall, Turn } from "../types.ts";
import {
  BUILD_TOOLS,
  MEMORY_ADD_TOOL,
  ROUTINE_CREATE_TOOL,
} from "./tool-names.ts";

function allToolCalls(transcript: readonly Turn[]): ToolCall[] {
  return transcript.flatMap((turn) => turn.toolCalls);
}

function toolCallsUpTo(
  transcript: readonly Turn[],
  turnIndex: number,
): ToolCall[] {
  return transcript.slice(0, turnIndex).flatMap((turn) => turn.toolCalls);
}

function result(
  name: string,
  pass: boolean,
  reason: string,
  score = pass ? 1 : 0,
): ScorerResult {
  return { name, pass, reason, score };
}

/** Fails if the current step's reply asks more than `max` questions
 * (counted as '?' occurrences) — the interview step's "≤4 plain
 * questions in ONE message" rule. */
export function asksQuestions(options: { max: number }) {
  return function asksQuestionsScorer(ctx: ScorerContext): ScorerResult {
    const reply = ctx.transcript[ctx.turnIndex]?.replyText ?? "";
    const count = (reply.match(/\?/g) ?? []).length;
    return result(
      "asksQuestions",
      count > 0 && count <= options.max,
      `reply asked ${String(count)} question(s), max ${String(options.max)}`,
    );
  };
}

/** Fails if any of `tools` was called on the current step — used to
 * assert the interview step builds nothing yet (e.g.
 * `noToolCalls(["create_agent", "routine_create"])`). */
export function noToolCalls(tools: readonly string[]) {
  return function noToolCallsScorer(ctx: ScorerContext): ScorerResult {
    const called = (ctx.transcript[ctx.turnIndex]?.toolCalls ?? []).filter(
      (call) => tools.includes(call.name),
    );
    return result(
      "noToolCalls",
      called.length === 0,
      called.length === 0
        ? `none of [${tools.join(", ")}] called on this step`
        : `called on this step: ${called.map((c) => c.name).join(", ")}`,
    );
  };
}

/** Fails if any of `BUILD_TOOLS` (create_agent, routine_create,
 * dispatch_task) was called in a step before `interviewAnsweredAtStep`
 * — the owner's rule that the interview (step 1) must land before any
 * building (step 4) starts. */
export function noBuildBeforeAnswers(interviewAnsweredAtStep: number) {
  return function noBuildBeforeAnswersScorer(ctx: ScorerContext): ScorerResult {
    const early = toolCallsUpTo(
      ctx.transcript,
      Math.min(interviewAnsweredAtStep, ctx.turnIndex + 1),
    );
    const buildTools: readonly string[] = BUILD_TOOLS;
    const premature = early.filter((call) => buildTools.includes(call.name));
    return result(
      "noBuildBeforeAnswers",
      premature.length === 0,
      premature.length === 0
        ? "no build tool called before the interview step"
        : `build tool(s) called early: ${premature.map((c) => c.name).join(", ")}`,
    );
  };
}

/** Passes once every named tool has been called somewhere in the
 * transcript up to and including the current step. */
export function namesRequiredTools(tools: readonly string[]) {
  return function namesRequiredToolsScorer(ctx: ScorerContext): ScorerResult {
    const called = new Set(
      allToolCalls(ctx.transcript.slice(0, ctx.turnIndex + 1)).map(
        (call) => call.name,
      ),
    );
    const missing = tools.filter((tool) => !called.has(tool));
    return result(
      "namesRequiredTools",
      missing.length === 0,
      missing.length === 0
        ? `all required tools called: ${tools.join(", ")}`
        : `missing tool call(s): ${missing.join(", ")}`,
    );
  };
}

/** Passes once a memory_add call's arguments (JSON-stringified) contain
 * every one of `keys` as a substring — proof something recognizable
 * was actually written, not just that the tool fired. */
export function memoryWritten(keys: readonly string[]) {
  return function memoryWrittenScorer(ctx: ScorerContext): ScorerResult {
    const writes = allToolCalls(
      ctx.transcript.slice(0, ctx.turnIndex + 1),
    ).filter((call) => call.name === MEMORY_ADD_TOOL && !call.isError);
    const blob = JSON.stringify(writes.map((w) => w.arguments));
    const missing = keys.filter((key) => !blob.includes(key));
    return result(
      "memoryWritten",
      writes.length > 0 && missing.length === 0,
      writes.length === 0
        ? "no successful memory_add call yet"
        : missing.length === 0
          ? `memory_add recorded all of: ${keys.join(", ")}`
          : `memory_add missing: ${missing.join(", ")}`,
    );
  };
}

/**
 * Passes if create_agent succeeded and the created agent was invited
 * into the same workbench the conversation is running in — the tool's
 * own contract is "invite into the caller's channel by default" (see
 * `packages/agent-directory-tools/src/tool.ts`), so this checks the
 * call succeeded and its result mentions an invite/participant rather
 * than re-deriving invite plumbing here.
 */
export function agentCreatedInWorkbench() {
  return function agentCreatedInWorkbenchScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const creates = allToolCalls(
      ctx.transcript.slice(0, ctx.turnIndex + 1),
    ).filter((call) => call.name === "create_agent");
    const succeeded = creates.filter((call) => !call.isError);
    const invited = succeeded.filter((call) =>
      /invit|particip|address/i.test(call.result),
    );
    return result(
      "agentCreatedInWorkbench",
      creates.length > 0 && invited.length === creates.length,
      creates.length === 0
        ? "no create_agent call yet"
        : invited.length === creates.length
          ? `${String(creates.length)} agent(s) created, all invited`
          : `${String(creates.length - invited.length)} of ${String(creates.length)} created agent(s) show no invite in their result`,
    );
  };
}

/** Passes once routine_create succeeded with a trigger of the given
 * `kind` ("daily" | "weekly" | "cron" | "webhook"). */
export function routineCreated(options: { trigger: string }) {
  return function routineCreatedScorer(ctx: ScorerContext): ScorerResult {
    const creates = allToolCalls(
      ctx.transcript.slice(0, ctx.turnIndex + 1),
    ).filter((call) => call.name === ROUTINE_CREATE_TOOL && !call.isError);
    const matching = creates.filter((call) => {
      const trigger = call.arguments["trigger"];
      return (
        typeof trigger === "object" &&
        trigger !== null &&
        (trigger as Record<string, unknown>)["kind"] === options.trigger
      );
    });
    return result(
      "routineCreated",
      matching.length > 0,
      matching.length > 0
        ? `routine_create succeeded with trigger.kind="${options.trigger}"`
        : creates.length === 0
          ? "no successful routine_create call yet"
          : `routine_create ran but no call used trigger.kind="${options.trigger}"`,
    );
  };
}

/** Fails if routine_create was called before `okAtStep` — the owner's
 * rule that a routine is only ever created after explicit human OK
 * (step 6). */
export function routineCreatedOnlyAfterOk(okAtStep: number) {
  return function routineCreatedOnlyAfterOkScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const early = toolCallsUpTo(
      ctx.transcript,
      Math.min(okAtStep, ctx.turnIndex + 1),
    ).filter((call) => call.name === ROUTINE_CREATE_TOOL);
    return result(
      "routineCreatedOnlyAfterOk",
      early.length === 0,
      early.length === 0
        ? "no routine_create call before the OK step"
        : `routine_create called ${String(early.length)} time(s) before the OK step`,
    );
  };
}

const APPROVAL_PHRASES = [
  "go ahead",
  "do it",
  "sounds good",
  "yes",
  "approved",
  "approve",
  "ok",
  "okay",
  "sure",
  "run it",
];

function turnHasApproval(human: string): boolean {
  const lower = human.toLowerCase();
  return APPROVAL_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Fails if any of `tools` was called before some earlier (or the same)
 * step's human message carried a recognizable go-ahead phrase — i.e.
 * every call to a gated tool must be preceded by an explicit approval.
 * This is a proxy: the harness has no view into a real approval-UI
 * click, so "approval" here means the human's own words said yes.
 */
export function approvalGated(tools: readonly string[]) {
  return function approvalGatedScorer(ctx: ScorerContext): ScorerResult {
    const transcript = ctx.transcript.slice(0, ctx.turnIndex + 1);
    let approvedByStep = -1;
    for (const [index, turn] of transcript.entries()) {
      if (turnHasApproval(turn.human)) {
        approvedByStep = index;
        break;
      }
    }
    const violations: string[] = [];
    for (const [index, turn] of transcript.entries()) {
      const gatedCalls = turn.toolCalls.filter((call) =>
        tools.includes(call.name),
      );
      if (
        gatedCalls.length > 0 &&
        (approvedByStep === -1 || index < approvedByStep)
      ) {
        violations.push(
          `step ${String(index)}: ${gatedCalls.map((c) => c.name).join(", ")}`,
        );
      }
    }
    return result(
      "approvalGated",
      violations.length === 0,
      violations.length === 0
        ? `no gated tool (${tools.join(", ")}) ran before an approval`
        : `gated tool ran before approval — ${violations.join("; ")}`,
    );
  };
}

/**
 * Scores the current step's reply against a plain-English rubric using
 * a live model as judge. Reads `EVAL_PROVIDER_API_KEY`; when unset,
 * this returns a `skipped` result instead of ever attempting a network
 * call, so a keyless CI run never depends on this scorer passing or
 * failing. `judgeCall` is an injectable seam for tests — defaults to a
 * small Anthropic Messages API call when a key is present.
 */
export function judge(
  rubric: string,
  judgeCall?: (prompt: string) => Promise<{ pass: boolean; reason: string }>,
) {
  return async function judgeScorer(ctx: ScorerContext): Promise<ScorerResult> {
    const key = process.env["EVAL_PROVIDER_API_KEY"];
    if (key === undefined || key === "") {
      return {
        name: "judge",
        score: 1,
        pass: true,
        skipped: true,
        reason: "skipped: EVAL_PROVIDER_API_KEY not set",
      };
    }
    const reply = ctx.transcript[ctx.turnIndex]?.replyText ?? "";
    const prompt =
      `Rubric: ${rubric}\n\nReply to judge:\n${reply}\n\n` +
      'Answer with exactly one line: "PASS: <why>" or "FAIL: <why>".';
    const run =
      judgeCall ??
      (async (p: string) => {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-3-5-haiku-20241022",
            max_tokens: 200,
            messages: [{ role: "user", content: p }],
          }),
        });
        const data = (await res.json()) as {
          content?: { type: string; text?: string }[];
        };
        const text =
          data.content?.find((block) => block.type === "text")?.text ?? "";
        return { pass: text.trim().startsWith("PASS"), reason: text.trim() };
      });
    const { pass, reason } = await run(prompt);
    return { name: "judge", score: pass ? 1 : 0, pass, reason };
  };
}
