// The loop: fetch the pull request's diff once, run every reviewer over
// it, combine the passes into one review, post it. GitHub reach and the
// reviewer turn itself are seams — the host that owns inference and the
// connection's credential supplies them — so this module is the whole
// mechanism and nothing in it needs a network to be tested.
//
// Posting is not gated: a posted review is a comment, and a comment is
// what the standing grant on the connection already covers. Nothing here
// approves, requests changes, or merges.
//
// One reviewer failing does not fail the review. Its pass is recorded as
// "did not report" and the posted review names it, which is honest about
// coverage; dropping it silently would let a review read as complete
// when it was not.
//
// A run on a bot's own pull request is skipped outright, before any
// inference or posting happens — the bot-loop guard the workflow entry
// needs so a bot pushing a change never sets off a review that something
// downstream reacts to, which pushes again.
import type {
  PostedPullRequestReview,
  PullRequestDiff,
  PullRequestRef,
  PullRequestReviewCommentsPage,
  PullRequestReviewDraft,
} from "@corbits/github-tools";

import { aggregateReview, type ReviewerPass } from "./aggregate";
import { isBotAuthor } from "./bot-guard";
import { fingerprintsIn } from "./fingerprint";
import { renderReviewPrompt } from "./prompt";
import { CODE_REVIEW_REVIEWERS, type ReviewerDefinition } from "./reviewers";

/** The GitHub reach a review run needs, under the connection's credential. */
export interface CodeReviewGitHub {
  fetchDiff(ref: PullRequestRef): Promise<PullRequestDiff>;
  postReview(
    ref: PullRequestRef,
    headSha: string,
    review: PullRequestReviewDraft,
  ): Promise<PostedPullRequestReview>;
  /** Bodies of every review comment already posted, for the fingerprint scan. */
  listPostedComments(
    ref: PullRequestRef,
  ): Promise<PullRequestReviewCommentsPage>;
}

/** Runs one reviewer's turn and returns its raw reply. */
export type ReviewerTurn = (input: {
  readonly reviewer: ReviewerDefinition;
  readonly prompt: string;
}) => Promise<string>;

export interface RunPullRequestReviewDeps {
  readonly github: CodeReviewGitHub;
  readonly runReviewerTurn: ReviewerTurn;
  /** Defaults to the full roster; narrowed in tests and in a smoke run. */
  readonly reviewers?: readonly ReviewerDefinition[];
}

export interface PullRequestReviewRun {
  readonly skipped: false;
  readonly diff: PullRequestDiff;
  readonly passes: readonly ReviewerPass[];
  readonly review: PullRequestReviewDraft;
  readonly posted: PostedPullRequestReview;
}

/** A run skipped before any inference or posting happened, and why. */
export interface PullRequestReviewSkipped {
  readonly skipped: true;
  readonly reason: string;
}

export type PullRequestReviewResult =
  PullRequestReviewRun | PullRequestReviewSkipped;

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runOne(
  deps: RunPullRequestReviewDeps,
  reviewer: ReviewerDefinition,
  prompt: string,
): Promise<ReviewerPass> {
  try {
    const reply = await deps.runReviewerTurn({ reviewer, prompt });
    return { reviewer, ok: true, reply };
  } catch (err) {
    return { reviewer, ok: false, reason: reasonOf(err) };
  }
}

/**
 * Reviews one pull request end to end and posts the result. Throws only
 * when the diff cannot be read or the review cannot be posted — the two
 * failures that mean no review happened at all. Returns `skipped: true`,
 * with no inference and no post, when the author reads as a bot.
 */
export async function runPullRequestReview(
  deps: RunPullRequestReviewDeps,
  ref: PullRequestRef,
): Promise<PullRequestReviewResult> {
  const reviewers = deps.reviewers ?? CODE_REVIEW_REVIEWERS;
  if (reviewers.length === 0) {
    throw new Error("a pull-request review needs at least one reviewer");
  }
  const diff = await deps.github.fetchDiff(ref);
  if (isBotAuthor(diff.author)) {
    return {
      skipped: true,
      reason: `"${diff.author}" reads as a bot author; skipping to avoid a review loop`,
    };
  }
  const prompt = renderReviewPrompt(diff);
  const postedComments = await deps.github.listPostedComments(ref);
  const alreadyPosted = fingerprintsIn(postedComments.comments);
  const passes = await Promise.all(
    reviewers.map((reviewer) => runOne(deps, reviewer, prompt)),
  );
  const review = aggregateReview(
    passes,
    diff,
    alreadyPosted,
    postedComments.truncated,
  );
  const posted = await deps.github.postReview(ref, diff.headSha, review);
  return { skipped: false, diff, passes, review, posted };
}
