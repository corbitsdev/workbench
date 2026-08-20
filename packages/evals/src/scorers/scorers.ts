// Composable, pure scoring functions over a recorded `Turn` (see
// ../types.ts) — the same `{score, pass, reason}` contract for a
// deterministic check and an LLM-judge check alike. No hub, no
// network, no clock in any scorer but `judge`, so every one of these
// is unit-testable on hand-built transcripts (see scorers.test.ts)
// without booting the real stack.

import { callEvalModel } from "../model-call.ts";
import type { ScorerContext, ScorerResult, ToolCall, Turn } from "../types.ts";
import {
  BUILD_TOOLS,
  GITHUB_POST_REVIEW_COMMENT_TOOL,
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
        const { text } = await callEvalModel(p, key);
        return { pass: text.trim().startsWith("PASS"), reason: text.trim() };
      });
    const { pass, reason } = await run(prompt);
    return { name: "judge", score: pass ? 1 : 0, pass, reason };
  };
}

// --- CL-6322 §8.2 scorers -------------------------------------------
//
// Every scorer below grades "what Myra actually built" (plan.md §8.1
// item 1), not what a tool call merely asked for. The first three read
// `ctx.world` (CL-6336 shipped it on `ScorerContext`, always present —
// see ../types.ts) for real. `reviewCommentsAttributable` and
// `wholeRunInspectable` still skip unconditionally: `WorldSnapshot`
// has no `reviewComments`/`runs` sections at all yet, so there is
// nothing to read until Phase 1.3 (`onTrigger` adoption) gives each
// fired occurrence its own child run id to attribute a comment or run
// to. The last two read the transcript alone and are buildable today;
// they still read red because the GitHub-write tool they check for
// doesn't exist yet (CL-6325).

/** Passes once a `github` connection in the world snapshot is live —
 * i.e. the connection went through `@corbits/connections`, not a
 * hand-rolled token stashed some other way. */
export function githubConnectedViaConnectionsLayer() {
  return function githubConnectedViaConnectionsLayerScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const github = ctx.world.connections.find(
      (connection) => connection.slug === "github",
    );
    const connected = github?.live === true;
    return result(
      "githubConnectedViaConnectionsLayer",
      connected,
      connected
        ? "github connection reads live=true from the world snapshot"
        : `github connection not live in the world snapshot (found: ${JSON.stringify(github)})`,
    );
  };
}

/** Passes once every named reviewer handle has a materialized agent
 * definition carrying a GitHub-shaped tool-package pin — proof the
 * grant actually stuck, not just that `create_agent` was asked to add
 * it. */
export function agentDefinitionsHaveToolGrants(handles: readonly string[]) {
  return function agentDefinitionsHaveToolGrantsScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const missing = handles.filter(
      (handle) =>
        !ctx.world.agentDefinitions.some(
          (definition) =>
            definition.name === handle &&
            definition.toolPackagePins.some((pin) => /github/i.test(pin)),
        ),
    );
    return result(
      "agentDefinitionsHaveToolGrants",
      missing.length === 0,
      missing.length === 0
        ? `all of [${handles.join(", ")}] have a materialized definition with a github-shaped tool pin`
        : `missing a materialized github-grant definition for: ${missing.join(", ")}`,
    );
  };
}

function triggerWebhookId(trigger: unknown): string | undefined {
  if (typeof trigger !== "object" || trigger === null) return undefined;
  const record = trigger as Record<string, unknown>;
  if (record["kind"] !== "webhook") return undefined;
  return typeof record["webhookTriggerId"] === "string"
    ? record["webhookTriggerId"]
    : undefined;
}

/** Passes once a routine in the snapshot has `trigger.kind ===
 * "webhook"` bound to a resolved `webhookTriggerId` — proof the
 * trigger actually fires per PR event rather than on a poll. */
export function triggerIsWebhookPerPr() {
  return function triggerIsWebhookPerPrScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const webhookRoutine = ctx.world.routines.find(
      (routine) => triggerWebhookId(routine.trigger) !== undefined,
    );
    return result(
      "triggerIsWebhookPerPr",
      webhookRoutine !== undefined,
      webhookRoutine !== undefined
        ? `routine ${webhookRoutine.id} has a resolved webhook trigger (${triggerWebhookId(webhookRoutine.trigger) ?? ""})`
        : "no routine in the snapshot has a resolved webhook trigger",
    );
  };
}

/** Passes once every named reviewer handle posted at least one review
 * comment, and every posted comment carries its own `childRunId` — the
 * per-turn/per-reviewer run tracing CL-6322 Phase 1.3 (`onTrigger`
 * adoption) is meant to produce. `WorldSnapshot` carries no review
 * comments at all yet, so this always skips, naming Phase 1.3 as the
 * blocker rather than failing on a gap this eval case cannot close by
 * itself. */
export function reviewCommentsAttributable(handles: readonly string[]) {
  return function reviewCommentsAttributableScorer(
    _ctx: ScorerContext,
  ): ScorerResult {
    return {
      name: "reviewCommentsAttributable",
      score: 1,
      pass: true,
      skipped: true,
      reason:
        `skipped: WorldSnapshot carries no reviewComments for [${handles.join(", ")}] to attribute — ` +
        "blocked on Phase 1.3 (per-turn/per-reviewer run-id tracing via onTrigger adoption, CL-6322)",
    };
  };
}

/** Passes once every successful `github_post_review_comment` call
 * carries a non-empty `suggestedFix` — read purely off the tool
 * call's own arguments, no snapshot needed. Reads red today because
 * the tool itself doesn't exist yet (CL-6325), so no such call is ever
 * in the transcript to check. */
export function suggestedFixesStructurallyValid() {
  return function suggestedFixesStructurallyValidScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const calls = allToolCalls(
      ctx.transcript.slice(0, ctx.turnIndex + 1),
    ).filter(
      (call) => call.name === GITHUB_POST_REVIEW_COMMENT_TOOL && !call.isError,
    );
    if (calls.length === 0) {
      return result(
        "suggestedFixesStructurallyValid",
        false,
        `no successful ${GITHUB_POST_REVIEW_COMMENT_TOOL} call yet — blocked on CL-6325 (no GitHub write tool exists)`,
      );
    }
    const invalid = calls.filter((call) => {
      const fix = call.arguments["suggestedFix"];
      return typeof fix !== "string" || fix.trim() === "";
    });
    return result(
      "suggestedFixesStructurallyValid",
      invalid.length === 0,
      invalid.length === 0
        ? `all ${String(calls.length)} review comment(s) carry a non-empty suggestedFix`
        : `${String(invalid.length)} of ${String(calls.length)} review comment(s) have no suggestedFix`,
    );
  };
}

/**
 * Encodes the owner's ruling on where the approval boundary sits for
 * an outward GitHub action: posting a review comment is FREE under a
 * valid per-repo grant (must NOT wait on a human approval phrase), but
 * a merge-class action (opening/landing a merge, not reviewing) DOES
 * park behind one — the same contract `approvalGated` already proves
 * for `routine_create`, applied here to `mergeTool`. Two assertions,
 * one scorer, because they're the same ruling read two ways: passes
 * once (a) every successful `github_post_review_comment` call is
 * scoped to `repo` and carries an `authorAgentHandle` for audit
 * attribution, with no approval-phrase requirement, and (b) any
 * `mergeTool` call found only ever follows an approval phrase. Reads
 * red today because neither GitHub-write tool exists yet (CL-6325) —
 * (a) fails on "no call yet," and this eval's step 4 never calls
 * `mergeTool` at all (Pass 1 stops at "review posted"), so (b) is
 * vacuously satisfied until CL-6325 gives it something to check.
 */
export function outwardGitHubActionsRespectGrantBoundary(
  repo: string,
  mergeTool: string,
) {
  return function outwardGitHubActionsRespectGrantBoundaryScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const transcript = ctx.transcript.slice(0, ctx.turnIndex + 1);
    const postCalls = allToolCalls(transcript).filter(
      (call) => call.name === GITHUB_POST_REVIEW_COMMENT_TOOL && !call.isError,
    );
    if (postCalls.length === 0) {
      return result(
        "outwardGitHubActionsRespectGrantBoundary",
        false,
        `no successful ${GITHUB_POST_REVIEW_COMMENT_TOOL} call yet — blocked on CL-6325 (no GitHub write tool exists, and no per-repo grant concept to post under)`,
      );
    }
    const offRepo = postCalls.filter((call) => call.arguments["repo"] !== repo);
    const unattributed = postCalls.filter((call) => {
      const author = call.arguments["authorAgentHandle"];
      return typeof author !== "string" || author.trim() === "";
    });

    let approvedByStep = -1;
    for (const [index, turn] of transcript.entries()) {
      if (turnHasApproval(turn.human)) {
        approvedByStep = index;
        break;
      }
    }
    const mergedBeforeApproval: string[] = [];
    for (const [index, turn] of transcript.entries()) {
      const gated = turn.toolCalls.filter((call) => call.name === mergeTool);
      if (
        gated.length > 0 &&
        (approvedByStep === -1 || index < approvedByStep)
      ) {
        mergedBeforeApproval.push(`step ${String(index)}`);
      }
    }

    const pass =
      offRepo.length === 0 &&
      unattributed.length === 0 &&
      mergedBeforeApproval.length === 0;
    return result(
      "outwardGitHubActionsRespectGrantBoundary",
      pass,
      pass
        ? `all ${String(postCalls.length)} review comment(s) posted free under the ${repo} grant with audit attribution, and no ${mergeTool} call ran before approval`
        : `${String(offRepo.length)} post(s) outside the ${repo} grant, ${String(unattributed.length)} missing authorAgentHandle, ${mergeTool} ran before approval at: ${mergedBeforeApproval.join(", ") || "none"}`,
    );
  };
}

/** Passes once every fired reviewer run is inspectable after the fact
 * via its own event-log reference (plan.md §8.2 item 7). `WorldSnapshot`
 * carries no per-run event-log references at all yet, so this always
 * skips — the same `onTrigger`-adoption dependency
 * `reviewCommentsAttributable` names for per-run ids. */
export function wholeRunInspectable() {
  return function wholeRunInspectableScorer(_ctx: ScorerContext): ScorerResult {
    return {
      name: "wholeRunInspectable",
      score: 1,
      pass: true,
      skipped: true,
      reason:
        "skipped: WorldSnapshot carries no per-run eventLogRef yet — " +
        "blocked on Phase 1.3 (per-turn/per-reviewer run-id tracing via onTrigger adoption, CL-6322)",
    };
  };
}
