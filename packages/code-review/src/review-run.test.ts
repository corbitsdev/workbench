// The loop, with GitHub faked: one diff read, one turn per reviewer,
// one review posted at the head sha.
import { expect, test } from "bun:test";
import type {
  PullRequestDiff,
  PullRequestRef,
  PullRequestReviewDraft,
} from "@corbits/github-tools";

import { CODE_REVIEW_REVIEWERS } from "./reviewers";
import { runPullRequestReview, type CodeReviewGitHub } from "./review-run";

const REF: PullRequestRef = { owner: "acme", repo: "widgets", number: 7 };

const DIFF: PullRequestDiff = {
  ref: REF,
  title: "Add the review loop",
  description: "Closes the loop.",
  url: "https://github.com/acme/widgets/pull/7",
  headSha: "headsha",
  baseSha: "basesha",
  files: [
    {
      path: "src/loop.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1,1 +1,2 @@\n context\n+added",
      changedLines: [1, 2],
    },
  ],
};

interface FakeGitHub {
  readonly client: CodeReviewGitHub;
  readonly posted: {
    ref: PullRequestRef;
    headSha: string;
    review: PullRequestReviewDraft;
  }[];
  readonly diffReads: PullRequestRef[];
}

function fakeGitHub(): FakeGitHub {
  const posted: FakeGitHub["posted"][number][] = [];
  const diffReads: PullRequestRef[] = [];
  return {
    posted,
    diffReads,
    client: {
      fetchDiff: (ref) => {
        diffReads.push(ref);
        return Promise.resolve(DIFF);
      },
      postReview: (ref, headSha, review) => {
        posted.push({ ref, headSha, review });
        return Promise.resolve({
          id: 1,
          url: "https://github.com/acme/widgets/pull/7#review",
        });
      },
    },
  };
}

function reportFor(reviewerId: string): string {
  return JSON.stringify({
    summary: `${reviewerId} read the diff`,
    findings: [
      {
        severity: "should-fix",
        file: "src/loop.ts",
        line: 2,
        summary: `${reviewerId} finding`,
      },
    ],
  });
}

test("every reviewer sees the same diff and the review is posted once", async () => {
  const github = fakeGitHub();
  const prompts: string[] = [];
  const seen: string[] = [];

  const result = await runPullRequestReview(
    {
      github: github.client,
      runReviewerTurn: ({ reviewer, prompt }) => {
        seen.push(reviewer.id);
        prompts.push(prompt);
        return Promise.resolve(reportFor(reviewer.id));
      },
    },
    REF,
  );

  expect(github.diffReads).toEqual([REF]);
  expect(seen.sort()).toEqual(
    CODE_REVIEW_REVIEWERS.map((reviewer) => reviewer.id).sort(),
  );
  expect(new Set(prompts).size).toBe(1);
  expect(prompts[0]).toContain("src/loop.ts");
  expect(github.posted.length).toBe(1);
  expect(github.posted[0]?.headSha).toBe("headsha");
  for (const reviewer of CODE_REVIEW_REVIEWERS) {
    expect(github.posted[0]?.review.body).toContain(`${reviewer.id} finding`);
  }
  expect(result.posted.id).toBe(1);
});

test("one reviewer failing still posts a review that names the gap", async () => {
  const github = fakeGitHub();
  const result = await runPullRequestReview(
    {
      github: github.client,
      runReviewerTurn: ({ reviewer }) =>
        reviewer.id === "release-risk"
          ? Promise.reject(new Error("inference timed out"))
          : Promise.resolve(reportFor(reviewer.id)),
    },
    REF,
  );

  expect(github.posted.length).toBe(1);
  expect(result.review.body).toContain("Reviewers that did not report");
  expect(result.review.body).toContain("inference timed out");
  expect(result.review.body).toContain("correctness finding");
});

test("a diff that cannot be read means no review is posted", async () => {
  const github = fakeGitHub();
  await expect(
    runPullRequestReview(
      {
        github: {
          fetchDiff: () => Promise.reject(new Error("404 not found")),
          postReview: github.client.postReview,
        },
        runReviewerTurn: () => Promise.resolve(reportFor("correctness")),
      },
      REF,
    ),
  ).rejects.toThrow(/404 not found/);
  expect(github.posted.length).toBe(0);
});

test("a review needs at least one reviewer", async () => {
  const github = fakeGitHub();
  await expect(
    runPullRequestReview(
      {
        github: github.client,
        runReviewerTurn: () => Promise.resolve("{}"),
        reviewers: [],
      },
      REF,
    ),
  ).rejects.toThrow(/at least one reviewer/);
});
