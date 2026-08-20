import { expect, test } from "bun:test";
import type {
  PullRequestDiff,
  PullRequestFileDiff,
} from "@corbits/github-tools";

import { renderReviewPrompt } from "./prompt";

function file(path: string, patchChars: number): PullRequestFileDiff {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: `@@ -1,1 +1,2 @@\n${"+x".repeat(patchChars / 2)}`,
    changedLines: [1],
  };
}

function diffOf(files: readonly PullRequestFileDiff[]): PullRequestDiff {
  return {
    ref: { owner: "acme", repo: "widgets", number: 7 },
    title: "Big change",
    description: "",
    url: "https://github.com/acme/widgets/pull/7",
    author: "octocat",
    headSha: "headsha",
    baseSha: "basesha",
    files,
  };
}

test("a pull request with no description says so instead of leaving a gap", () => {
  const prompt = renderReviewPrompt(diffOf([file("a.ts", 10)]));
  expect(prompt).toContain("(none given)");
  expect(prompt).toContain("a.ts");
});

test("an oversized patch is truncated and says it was", () => {
  const prompt = renderReviewPrompt(diffOf([file("a.ts", 40000)]));
  expect(prompt).toContain("patch truncated");
});

test("a change too large for one turn names the files it left out", () => {
  const many = Array.from({ length: 40 }, (_unused, index) =>
    file(`file-${String(index)}.ts`, 8000),
  );
  const prompt = renderReviewPrompt(diffOf(many));
  expect(prompt.length).toBeLessThan(200000);
  expect(prompt).toContain("Not shown to you");
  expect(prompt).toContain("file-39.ts");
});
