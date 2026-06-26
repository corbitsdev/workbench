import type { GitHubIssueOrPR, GitHubRepo } from "./types";

export function normalizeGitHubRepo(repo: GitHubRepo) {
  return {
    url: repo.html_url,
    title: `${repo.full_name}: ${repo.description ?? ""}`,
    publishedAt: repo.pushed_at,
    source: "github",
    // A repo has stars, not upvotes/comments — omit the vote fields rather than
    // emitting a misleading zero.
    engagement: {
      stars: repo.stargazers_count,
    },
    entityTag: repo.full_name,
  };
}

export function normalizeGitHubIssueOrPR(item: GitHubIssueOrPR) {
  return {
    url: item.html_url,
    title: item.title,
    publishedAt: item.updated_at,
    source: "github",
    engagement: {
      upvotes: item.reactions.total_count,
      comments: item.comments,
    },
  };
}
