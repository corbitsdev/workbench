/**
 * CLI entry for the Myra v1 prompt eval corpus.
 *
 * Default mode is the scripted adapter (CI-safe, no credentials, no network).
 * Pass `--live` only when an operator wants a real model adapter — that path
 * is intentionally not wired here yet: live inference must go through a
 * sandbox/staging tenant via admin once a production adapter is registered.
 *
 * Usage (from repo root):
 *   bun run packages/myra/src/eval/run-baseline.ts
 *   bun run packages/myra/src/eval/run-baseline.ts --runs 3 --out tmp/myra-v1-scorecard.md
 *   bun run packages/myra/src/eval/run-baseline.ts --production-prompt
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { V1_EVAL_CASES } from "./fixtures";
import {
  composeStubEvalPrompt,
  createPassingScriptedAdapter,
  runEvalCase,
  type ComposeEvalPrompt,
} from "./runner";
import { buildScorecard, formatScorecardMarkdown } from "./scorecard";
import type { ScorecardRun } from "./scorecard";

function parseArgs(argv: string[]): {
  runs: number;
  out: string | null;
  live: boolean;
  productionPrompt: boolean;
} {
  let runs = 3;
  let out: string | null = null;
  let live = false;
  let productionPrompt = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(
          `--runs requires a positive integer, got ${argv[i + 1]}`,
        );
      }
      runs = n;
      i += 1;
    } else if (a === "--out") {
      const path = argv[i + 1];
      if (path === undefined || path.startsWith("-")) {
        throw new Error("--out requires a path");
      }
      out = path;
      i += 1;
    } else if (a === "--live") {
      live = true;
    } else if (a === "--production-prompt") {
      productionPrompt = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: run-baseline.ts [--runs N] [--out path.md] [--production-prompt] [--live]\n" +
          "  Default adapter is scripted (CI). --live requires a registered live adapter.\n" +
          "  --production-prompt composes the real Myra system prompt (needs workspace deps).",
      );
      process.exit(0);
    }
  }
  return { runs, out, live, productionPrompt };
}

async function resolveCompose(
  productionPrompt: boolean,
): Promise<{ compose: ComposeEvalPrompt; promptVersion: string }> {
  if (!productionPrompt) {
    return { compose: composeStubEvalPrompt, promptVersion: "stub" };
  }
  const mod = await import("./compose-prompt");
  return {
    compose: mod.composePersonalAgentEvalPrompt,
    promptVersion: mod.PERSONAL_AGENT_PROMPT_VERSION,
  };
}

async function main(): Promise<void> {
  const { runs, out, live, productionPrompt } = parseArgs(
    process.argv.slice(2),
  );
  if (live) {
    throw new Error(
      "live model adapter is not registered in this binary — run the scripted baseline " +
        "for schema/scorer CI, and attach live staging scorecards via the admin path once " +
        "a sandbox adapter is configured (CL-3193 / CL-3199).",
    );
  }

  const { compose, promptVersion } = await resolveCompose(productionPrompt);
  const adapter = createPassingScriptedAdapter();
  const scorecardRuns: ScorecardRun[] = [];

  for (const c of V1_EVAL_CASES) {
    const scores = [];
    for (let i = 0; i < runs; i++) {
      const result = await runEvalCase(c, adapter, { composePrompt: compose });
      scores.push(result.score);
      const mark = result.score.passed ? "PASS" : "FAIL";
      console.log(
        `[${mark}] ${c.id} run ${i + 1}/${runs} tools=${result.trace.toolCalls.length}`,
      );
    }
    scorecardRuns.push({ caseId: c.id, title: c.title, scores });
  }

  const card = buildScorecard({
    corpus: "v1",
    promptVersion,
    model: "scripted-pass",
    runs: scorecardRuns,
  });
  const md = formatScorecardMarkdown(card);
  console.log("\n" + md);

  if (out !== null) {
    const abs = resolve(out);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, md, "utf8");
    writeFileSync(
      abs.replace(/\.md$/i, "") + ".json",
      JSON.stringify(card, null, 2) + "\n",
      "utf8",
    );
    console.log(`wrote ${abs}`);
  }

  if (card.summary.failedRuns > 0) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
