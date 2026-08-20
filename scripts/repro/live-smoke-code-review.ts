/**
 * Live smoke harness for the code-review MVP (CL-6340): fetches a real
 * pull request's diff via @corbits/github-tools, runs the three
 * @corbits/code-review reviewer lenses against a real Anthropic model
 * call, aggregates the passes, and posts the review to GitHub for real.
 *
 * This is a smoke harness, not product plumbing: `runReviewerTurn` here
 * is a direct Anthropic Messages API call (the same minimal seam
 * packages/evals/src/model-call.ts already uses for eval-side model
 * calls), because the MVP report flagged that no production inference
 * binding exists yet for `runReviewerTurn` — the review-run package
 * only defines the seam (packages/code-review/src/review-run.ts), it
 * does not wire one.
 *
 * Run: bun run scripts/repro/live-smoke-code-review.ts <owner>/<repo>#<pr-number>
 * Env: GITHUB_TOKEN (falls back to `gh auth token` if unset)
 *      ANTHROPIC_API_KEY (required — no fallback; this script never
 *      reads a credential store on its own)
 */
import { spawnSync } from "node:child_process";

import {
  createGitHubReviewClient,
  runPullRequestReview,
  type ReviewerDefinition,
} from "@corbits/code-review";
import type { PullRequestRef } from "@corbits/github-tools";

const MODEL = "claude-sonnet-4-5-20250929";

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
      model: MODEL,
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

async function main(): Promise<void> {
  const targetArg = process.argv[2];
  if (targetArg === undefined) {
    throw new Error(
      "usage: bun run scripts/repro/live-smoke-code-review.ts <owner>/<repo>#<pr-number>",
    );
  }
  const ref = parseTarget(targetArg);

  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  if (anthropicKey === undefined || anthropicKey.length === 0) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — this harness makes a real inference " +
        "call and does not fall back to anything",
    );
  }

  const github = createGitHubReviewClient({ apiKey: ghToken() });

  const timings: Record<string, number> = {};
  const t0 = performance.now();

  const result = await runPullRequestReview(
    {
      github,
      runReviewerTurn: async ({
        reviewer,
        prompt,
      }: {
        reviewer: ReviewerDefinition;
        prompt: string;
      }) => {
        const passStart = performance.now();
        const reply = await callAnthropic(
          reviewer.systemPrompt,
          prompt,
          anthropicKey,
        );
        timings[`pass:${reviewer.id}`] = performance.now() - passStart;
        return reply;
      },
    },
    ref,
  );

  timings["total"] = performance.now() - t0;

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
