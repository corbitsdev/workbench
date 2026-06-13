import type { GitHubPR, GitHubRepo } from './types';

export function normalizeGitHubRepo(repo: GitHubRepo) {
  return {
    url: repo.html_url,
    title: `${repo.full_name}: ${repo.description ?? ''}`,
    publishedAt: repo.pushed_at,
    source: 'github',
    engagement: {
      upvotes: repo.stargazers_count,
      comments: 0,
    },
    entityTag: repo.full_name,
  };
}

export function normalizeGitHubPR(pr: GitHubPR) {
  return {
    url: pr.html_url,
    title: pr.title,
    publishedAt: pr.created_at,
    source: 'github',
    engagement: {
      upvotes: pr.reactions.total_count,
      comments: 0,
    },
  };
}
