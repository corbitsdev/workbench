import type { GitHubIssueOrPR, GitHubRepo } from "./types";

export function normalizeGitHubRepo(repo: GitHubRepo) {
  return {
    url: repo.html_url,
    title: `${repo.full_name}: ${repo.description ?? ""}`,
    publishedAt: repo.pushed_at,
    source: "github",
    engagement: {
      upvotes: repo.stargazers_count,
      comments: 0,
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
