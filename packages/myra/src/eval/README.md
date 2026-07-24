# Myra prompt evaluation harness (CL-3193)

Synthetic, runtime-validated cases for Myra's Chief of Staff prompt.

## What this is

- **Case format** (`case.ts`) — user input, fixed context, fake tools, hard
  constraints, answer assertions. ArkType-validated.
- **v1 corpus** (`fixtures.ts`) — 10 hard cases: greeting, internal-first
  research, fresh data, clarification, failure reporting, missing capability,
  approval, prompt injection, workflow state, multi-step synthesis.
- **Judgment-scenario corpus** (`fixtures.ts` → `JUDGMENT_EVAL_CASES`, CL-4138)
  — 7 cases targeting behavior the v1 → v2 prompt revision (CL-4121) changed:
  ask-vs-act on irreversible actions (external email, artifact delete,
  teammate note — each modeled as an approval-gated tool call, mirroring the
  v1 `approval-behavior` case, so passing means stating the plan/confirming
  rather than claiming the action already completed) plus a reversible
  contrast case, partial-failure reporting across two shapes, and the
  search-loop stop after two fruitless rounds. `ALL_EVAL_CASES` is
  `V1_EVAL_CASES` + `JUDGMENT_EVAL_CASES`.
- **Synthetic tools** (`tools.ts`) — production-shaped names/descriptions;
  fixture results only (no customer data, no live credentials).
- **Deterministic scorer** (`scorer.ts`) — pure functions over a captured
  trace; same inputs always yield the same pass/fail.
- **Runner** (`runner.ts`) — composes prompt + advertised tools, drives an
  `EvalModelAdapter`, captures usage/latency/retries, scores.
- **Scorecard** (`scorecard.ts`) — multi-run aggregate (pass rate, tool
  counts, tokens, latency, false completions) + markdown report.

## CI vs live

| Mode                                    | Command                                                   | Uses model?               |
| --------------------------------------- | --------------------------------------------------------- | ------------------------- |
| Schema + scorer CI                      | `bun test packages/myra/src/eval`                         | No (scripted adapters)    |
| Scripted baseline report                | `bun run packages/myra/src/eval/run-baseline.ts --runs 3` | No                        |
| Real Myra system prompt + scripted plan | add `--production-prompt`                                 | No (still scripted tools) |
| Live production model                   | `--live` (not registered yet — CL-3199 canary)            | Yes                       |

Live evaluation is an **explicit** admin/runtime path against a sandbox or
staging tenant. Do not put live-model runs in default CI.

## Known scorer gap (CL-4138 review)

`scorer.ts` scores tool _names_ (mustCallTools/mustNotCallTools/toolSequence/
maxToolCalls) and final-answer _substrings_ (answerContains/
answerNotContains/forbidFalseCompletion). It cannot inspect:

- **Tool call arguments** — e.g. whether a `mail_send` call actually included
  or omitted a CC list. A case built to test "live instruction overrides a
  saved CC-everyone preference" cannot fail on the behavior it names: a model
  that CCs the team anyway still passes as long as the answer text happens
  not to contain the specific forbidden phrases, because the CC decision
  lives in the tool call's `args`, which the scorer never reads.
- **Answer ordering/structure** — e.g. whether the outcome is stated before
  supporting detail ("outcome-first" reporting). `answerContains` matches a
  substring anywhere in the text, so it cannot distinguish a reply that
  leads with the outcome from one that buries it after a wall of process
  narration.

Two cases exercising exactly these behaviors
(`live-instruction-overrides-saved-preference`,
`outcome-first-reporting-shape`) were removed from `JUDGMENT_EVAL_CASES` for
this reason — they were green noise (AGENTS.md: "a test that cannot fail is
a bug"). Re-add them once the scorer can read tool-call args and/or reason
about answer structure (e.g. an LLM-judge scorer), not before.

## Admin

`bun run admin` → Setup → **Run Myra v1 prompt eval baseline (scripted / CI-safe)**

Or: `bun run apps/hub/bin/run-myra-eval-baseline.ts --runs 3 --out tmp/scorecard.md`

## Comparing prompt generations (v1 vs v2, CL-4138)

`compose-prompt.ts` exports one `ComposeEvalPrompt` per entry in
`MYRA_PROMPT_GENERATIONS` (`packages/myra/src/core/prompts`):

- `composePersonalAgentEvalPrompt` — v1, `buildPersonalAgentSystemPrompt`.
- `composePersonalAgentEvalPromptV2` — v2, `buildPersonalAgentSystemPromptV2`.
  v2 requires a `model`; cases that don't set `context.model` fall back to a
  fixed `"eval-model"` label so every case composes under both generations.
- `EVAL_COMPOSE_BY_GENERATION` — the two above, keyed by
  `MyraPromptGeneration` (`"v1" | "v2"`), for driving one corpus across both.

To compare the two generations on the same corpus, run `runEvalCase` (or
build a small script around `buildScorecard`) once per generation, passing
`ALL_EVAL_CASES` and `options.composePrompt` from
`EVAL_COMPOSE_BY_GENERATION.v1` / `.v2`:

```ts
import { ALL_EVAL_CASES } from "./fixtures";
import { EVAL_COMPOSE_BY_GENERATION } from "./compose-prompt";
import { runEvalCase, createPassingScriptedAdapter } from "./runner";
import { buildScorecard, formatScorecardMarkdown } from "./scorecard";

for (const generation of ["v1", "v2"] as const) {
  const scores = [];
  for (const caseDef of ALL_EVAL_CASES) {
    scores.push(
      (
        await runEvalCase(caseDef, adapter, {
          composePrompt: EVAL_COMPOSE_BY_GENERATION[generation],
        })
      ).score,
    );
  }
  // feed `scores` into buildScorecard(...) per generation, then diff the
  // two markdown reports (formatScorecardMarkdown) for pass-rate deltas
  // on the judgment-scenario tags: ask-vs-act, partial-failure,
  // search-loop-stop.
}
```

`compose-prompt.ts` (and its test) is the one module in this package that
imports the full personal-agent definition graph — CI schema/scorer tests
(`fixtures.test.ts`, `runner.test.ts`) stay on `composeStubEvalPrompt` so
they do not pay that import cost. Wire a real model adapter in place of
`createPassingScriptedAdapter()` for an actual v1-vs-v2 judgment comparison;
the scripted adapter only proves both generations compose valid prompts.
