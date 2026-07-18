# Myra prompt evaluation harness (CL-3193)

Synthetic, runtime-validated cases for Myra's Chief of Staff prompt.

## What this is

- **Case format** (`case.ts`) — user input, fixed context, fake tools, hard
  constraints, answer assertions. ArkType-validated.
- **v1 corpus** (`fixtures.ts`) — 10 hard cases: greeting, internal-first
  research, fresh data, clarification, failure reporting, missing capability,
  approval, prompt injection, workflow state, multi-step synthesis.
- **Synthetic tools** (`tools.ts`) — production-shaped names/descriptions;
  fixture results only (no customer data, no live credentials).
- **Deterministic scorer** (`scorer.ts`) — pure functions over a captured
  trace; same inputs always yield the same pass/fail.
- **Runner** (`runner.ts`) — composes prompt + advertised tools, drives an
  `EvalModelAdapter`, captures usage/latency/retries, scores.
- **Scorecard** (`scorecard.ts`) — multi-run aggregate (pass rate, tool
  counts, tokens, latency, false completions) + markdown report.

## CI vs live

| Mode | Command | Uses model? |
| --- | --- | --- |
| Schema + scorer CI | `bun test packages/myra/src/eval` | No (scripted adapters) |
| Scripted baseline report | `bun run packages/myra/src/eval/run-baseline.ts --runs 3` | No |
| Real Myra system prompt + scripted plan | add `--production-prompt` | No (still scripted tools) |
| Live production model | `--live` (not registered yet — CL-3199 canary) | Yes |

Live evaluation is an **explicit** admin/runtime path against a sandbox or
staging tenant. Do not put live-model runs in default CI.

## Admin

`bun run admin` → Setup → **Run Myra v1 prompt eval baseline (scripted / CI-safe)**

Or: `bun run apps/hub/bin/run-myra-eval-baseline.ts --runs 3 --out tmp/scorecard.md`
