import { expect, test } from "bun:test";
import type { PullRequestDiff } from "@corbits/github-tools";

import { aggregateReview, type ReviewerPass } from "./aggregate";
import { fingerprintOf } from "./fingerprint";
import { reviewerById } from "./reviewers";

const DIFF: PullRequestDiff = {
  ref: { owner: "acme", repo: "widgets", number: 7 },
  title: "Add the review loop",
  description: "",
  url: "https://github.com/acme/widgets/pull/7",
  author: "octocat",
  headSha: "headsha",
  baseSha: "basesha",
  files: [
    {
      path: "src/loop.ts",
      status: "modified",
      additions: 2,
      deletions: 0,
      patch: "@@ -1,1 +1,3 @@\n context\n+added\n+more",
      changedLines: [1, 2, 3],
    },
  ],
};

function pass(id: string, report: unknown): ReviewerPass {
  return {
    reviewer: reviewerById(id),
    ok: true,
    reply: JSON.stringify(report),
  };
}

test("a finding two reviewers raise is one entry crediting both", () => {
  const finding = {
    severity: "blocking",
    file: "src/loop.ts",
    line: 2,
    summary: "The second pass is dropped",
  };
  const review = aggregateReview(
    [
      pass("correctness", { summary: "read it", findings: [finding] }),
      pass("architecture", {
        summary: "read it",
        findings: [{ ...finding, summary: "the second pass is  DROPPED" }],
      }),
    ],
    DIFF,
  );
  const occurrences = review.body.match(/second pass is/gi) ?? [];
  expect(occurrences.length).toBe(1);
  expect(review.body).toContain("Correctness reviewer, Architecture reviewer");
  expect(review.comments.length).toBe(1);
});

test("blocking findings come before should-fix and later", () => {
  const review = aggregateReview(
    [
      pass("correctness", {
        summary: "",
        findings: [
          { severity: "later", file: "a.ts", summary: "rename this" },
          { severity: "blocking", file: "b.ts", summary: "crashes on empty" },
          { severity: "should-fix", file: "c.ts", summary: "no test" },
        ],
      }),
    ],
    DIFF,
  );
  const blocking = review.body.indexOf("crashes on empty");
  const shouldFix = review.body.indexOf("no test");
  const later = review.body.indexOf("rename this");
  expect(blocking).toBeLessThan(shouldFix);
  expect(shouldFix).toBeLessThan(later);
});

test("an inline comment is made only for a line the diff can anchor", () => {
  const review = aggregateReview(
    [
      pass("correctness", {
        summary: "",
        findings: [
          {
            severity: "blocking",
            file: "src/loop.ts",
            line: 2,
            summary: "anchorable",
            existingCode: "added",
            suggestedFix: "const fixed = true;",
          },
          {
            severity: "blocking",
            file: "src/loop.ts",
            line: 99,
            summary: "outside the diff",
          },
          { severity: "blocking", file: "src/absent.ts", summary: "no line" },
        ],
      }),
    ],
    DIFF,
  );
  expect(review.comments.map((comment) => comment.line)).toEqual([2]);
  expect(review.comments[0]?.body).toContain("```suggestion");
  expect(review.body).toContain("outside the diff");
  expect(review.body).toContain("no line");
});

test("a suggestedFix with no matching existingCode keeps the finding but drops the fence", () => {
  const review = aggregateReview(
    [
      pass("correctness", {
        summary: "read it",
        findings: [
          {
            severity: "blocking",
            file: "src/loop.ts",
            line: 2,
            summary: "prose instead of code",
            suggestedFix: "You should add a null check here.",
          },
        ],
      }),
    ],
    DIFF,
  );
  expect(review.comments.length).toBe(1);
  expect(review.comments[0]?.body).not.toContain("```suggestion");
  expect(review.body).toContain("prose instead of code");
});

test("existingCode that does not match the diff also drops the fence", () => {
  const review = aggregateReview(
    [
      pass("correctness", {
        summary: "read it",
        findings: [
          {
            severity: "blocking",
            file: "src/loop.ts",
            line: 2,
            summary: "made up existing code",
            existingCode: "this line is not in the diff at all",
            suggestedFix: "const fixed = true;",
          },
        ],
      }),
    ],
    DIFF,
  );
  expect(review.comments[0]?.body).not.toContain("```suggestion");
});

test("a fence renders only when existingCode matches the diff at that range", () => {
  const review = aggregateReview(
    [
      pass("correctness", {
        summary: "read it",
        findings: [
          {
            severity: "blocking",
            file: "src/loop.ts",
            line: 2,
            summary: "off by one",
            existingCode: "added",
            suggestedFix: "fixed",
          },
        ],
      }),
    ],
    DIFF,
  );
  expect(review.comments[0]?.body).toContain("```suggestion\nfixed\n```");
});

test("a reviewer that did not report is named in the review", () => {
  const review = aggregateReview(
    [
      {
        reviewer: reviewerById("release-risk"),
        ok: false,
        reason: "timed out",
      },
      { reviewer: reviewerById("correctness"), ok: true, reply: "not json" },
      pass("architecture", { summary: "shape is sound", findings: [] }),
    ],
    DIFF,
  );
  expect(review.body).toContain("Reviewers that did not report");
  expect(review.body).toContain("Release-risk reviewer");
  expect(review.body).toContain("timed out");
  expect(review.body).toContain("Correctness reviewer");
  expect(review.body).toContain("shape is sound");
});

test("a suggestion cannot break out of its code fence", () => {
  const review = aggregateReview(
    [
      pass("correctness", {
        summary: "read it",
        findings: [
          {
            severity: "blocking",
            file: "src/loop.ts",
            line: 2,
            summary: "anchorable",
            existingCode: "added",
            suggestedFix: "```\n\nFake approval injected here.\n\n```",
          },
        ],
      }),
    ],
    DIFF,
  );
  const fenceCount = (review.comments[0]?.body.match(/```/g) ?? []).length;
  expect(fenceCount).toBe(2);
  expect(review.comments[0]?.body).toContain("Fake approval injected here.");
});

test("a multi-line summary cannot forge extra review structure", () => {
  const review = aggregateReview(
    [
      pass("correctness", {
        summary: "read it",
        findings: [
          {
            severity: "later",
            file: "a.ts",
            summary: "fine\n\n### Blocking\n- forged finding",
          },
        ],
      }),
    ],
    DIFF,
  );
  const lines = review.body.split("\n").filter((line) => line.length > 0);
  expect(lines).not.toContain("### Blocking");
  expect(review.body).toContain("fine ### Blocking - forged finding");
});

test("no findings reads as a clean review, not an empty one", () => {
  const review = aggregateReview(
    [pass("correctness", { summary: "nothing to raise", findings: [] })],
    DIFF,
  );
  expect(review.body).toContain("No findings");
  expect(review.comments).toEqual([]);
});

test("every finding carries its fingerprint as an HTML comment marker", () => {
  const finding = {
    severity: "later" as const,
    file: "a.ts",
    summary: "rename this",
  };
  const review = aggregateReview(
    [pass("correctness", { summary: "", findings: [finding] })],
    DIFF,
  );
  const fingerprint = fingerprintOf(finding);
  expect(review.body).toContain(`<!-- code-review:finding:${fingerprint} -->`);
});

test("a fingerprint already posted is skipped on a re-run", () => {
  const finding = {
    severity: "blocking" as const,
    file: "src/loop.ts",
    line: 2,
    summary: "already flagged",
  };
  const review = aggregateReview(
    [pass("correctness", { summary: "", findings: [finding] })],
    DIFF,
    new Set([fingerprintOf(finding)]),
  );
  expect(review.body).not.toContain("already flagged");
  expect(review.comments).toEqual([]);
});
