// Binds the review run's GitHub seam to `@corbits/github-tools`' REST
// client. The credential arrives as config from whoever resolved the
// connection — this module never reads an environment variable itself.
import {
  fetchPullRequestDiff,
  fetchPullRequestReviewComments,
  postPullRequestReview,
  type GitHubClientConfig,
} from "@corbits/github-tools";

import type { CodeReviewGitHub } from "./review-run";

/** The GitHub reach a review run needs, under a resolved credential. */
export function createGitHubReviewClient(
  config: GitHubClientConfig,
): CodeReviewGitHub {
  return {
    fetchDiff: (ref) => fetchPullRequestDiff(config, ref),
    postReview: (ref, headSha, review) =>
      postPullRequestReview(config, ref, headSha, review),
    listPostedComments: (ref) => fetchPullRequestReviewComments(config, ref),
  };
}
