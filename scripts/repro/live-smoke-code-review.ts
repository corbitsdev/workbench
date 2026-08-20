/**
 * Live smoke harness for the code-review MVP (CL-6340): fetches a real
 * pull request's diff via @corbits/github-tools, runs the three
 * @corbits/code-review reviewer lenses against a real model call,
 * aggregates the passes, and posts the review to GitHub for real.
 *
 * This is a smoke harness, not product plumbing: `runReviewerTurn` here
 * is a direct model call (the same minimal seam
 * packages/evals/src/model-call.ts already uses for eval-side model
 * calls), because the MVP report flagged that no production inference
 * binding exists yet for `runReviewerTurn` — the review-run package
 * only defines the seam (packages/code-review/src/review-run.ts), it
 * does not wire one.
 *
 * Two inference paths, chosen by what credential is present — an
 * ANTHROPIC_API_KEY when there is one, a local Ollama chat completion
 * (localhost:11434) when there is not. The Ollama path is HARNESS-ONLY:
 * it exists so this smoke run can prove the loop mechanics (diff fetch
 * → three passes → aggregate → post) for real without a paid credential
 * in the sandbox, not as a second production inference binding. The
 * production seam remains the known gap the MVP report flagged; nothing
 * here narrows it. Expect modest finding quality from a small local
 * model — that is not what this harness is proving.
 *
 * Run: bun run scripts/repro/live-smoke-code-review.ts <owner>/<repo>#<pr-number>
 * Env: GITHUB_TOKEN (falls back to `gh auth token` if unset)
 *      ANTHROPIC_API_KEY (preferred when set)
 *      OLLAMA_BASE_URL (default http://localhost:11434), OLLAMA_MODEL
 *      (default qwen2.5vl:7b) — used only when ANTHROPIC_API_KEY is unset
 */
import { spawnSync } from "node:child_process";

import {
  createGitHubReviewClient,
  runPullRequestReview,
  type ReviewerDefinition,
} from "@corbits/code-review";
import type { PullRequestRef } from "@corbits/github-tools";

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "qwen2.5vl:7b";

function parseTarget(arg: string): PullRequestRef {
  const match = /^([^/\s]+)\/([^/\s]+)#(\d+)$/.exec(arg);
  if (match === null) {
    throw new Error(`expected <owner>/<repo>#<pr-number>, got "${arg}"`);
  }
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) {
    throw new Error(`expected <owner>/<repo>#<pr-number>, got "${arg}"`);
  }
  return { owner, repo, number: Number(number) };
}

function ghToken(): string {
  const fromEnv = process.env["GITHUB_TOKEN"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  const token = result.stdout.trim();
  if (result.status !== 0 || token.length === 0) {
    throw new Error("no GITHUB_TOKEN and `gh auth token` produced nothing");
  }
  return token;
}

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Anthropic Messages API failed: ${String(res.status)} ${res.statusText} — ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  const text = data.content?.find((block) => block.type === "text")?.text;
  if (text === undefined) {
    throw new Error("Anthropic reply carried no text block");
  }
  return text;
}

/** HARNESS-ONLY fallback: a local Ollama chat completion. Not a second
 * production inference binding — see the module comment. */
async function callOllama(
  systemPrompt: string,
  userPrompt: string,
  baseUrl: string,
  model: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Ollama chat call failed: ${String(res.status)} ${res.statusText} — ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    message?: { content?: string };
  };
  const text = data.message?.content;
  if (text === undefined || text.length === 0) {
    throw new Error("Ollama reply carried no content");
  }
  return text;
}

async function main(): Promise<void> {
  const targetArg = process.argv[2];
  if (targetArg === undefined) {
    throw new Error(
      "usage: bun run scripts/repro/live-smoke-code-review.ts <owner>/<repo>#<pr-number>",
    );
  }
  const ref = parseTarget(targetArg);

  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  const ollamaBaseUrl =
    process.env["OLLAMA_BASE_URL"] ?? DEFAULT_OLLAMA_BASE_URL;
  const ollamaModel = process.env["OLLAMA_MODEL"] ?? DEFAULT_OLLAMA_MODEL;
  const inferenceMode =
    anthropicKey !== undefined && anthropicKey.length > 0
      ? "anthropic"
      : "ollama";
  console.log(
    inferenceMode === "anthropic"
      ? `Inference: Anthropic (${ANTHROPIC_MODEL})`
      : `Inference: Ollama fallback, HARNESS-ONLY (${ollamaModel} @ ${ollamaBaseUrl})`,
  );

  const github = createGitHubReviewClient({ apiKey: ghToken() });

  const timings: Record<string, number> = {};
  const runStart = performance.now();
  let diffDoneAt = runStart;
  let lastPassDoneAt = runStart;
  const timedGithub = {
    ...github,
    fetchDiff: async (fetchRef: PullRequestRef) => {
      const diff = await github.fetchDiff(fetchRef);
      diffDoneAt = performance.now();
      timings["diff-fetch"] = diffDoneAt - runStart;
      return diff;
    },
  };

  const result = await runPullRequestReview(
    {
      github: timedGithub,
      runReviewerTurn: async ({
        reviewer,
        prompt,
      }: {
        reviewer: ReviewerDefinition;
        prompt: string;
      }) => {
        const passStart = performance.now();
        const reply =
          inferenceMode === "anthropic"
            ? await callAnthropic(
                reviewer.systemPrompt,
                prompt,
                anthropicKey as string,
              )
            : await callOllama(
                reviewer.systemPrompt,
                prompt,
                ollamaBaseUrl,
                ollamaModel,
              );
        const passDoneAt = performance.now();
        timings[`pass:${reviewer.id}`] = passDoneAt - passStart;
        lastPassDoneAt = Math.max(lastPassDoneAt, passDoneAt);
        return reply;
      },
    },
    ref,
  );

  const runEnd = performance.now();
  timings["aggregate+post"] = runEnd - lastPassDoneAt;
  timings["total"] = runEnd - runStart;

  console.log(`Posted review: ${result.posted.url}`);
  console.log("");
  console.log("--- Timings (ms) ---");
  for (const [key, value] of Object.entries(timings)) {
    console.log(`${key}: ${value.toFixed(0)}`);
  }
  console.log("");
  console.log("--- Reviewer passes ---");
  for (const pass of result.passes) {
    console.log(
      pass.ok
        ? `${pass.reviewer.id}: ok`
        : `${pass.reviewer.id}: FAILED — ${pass.reason}`,
    );
  }
  console.log("");
  console.log("--- Posted body ---");
  console.log(result.review.body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
