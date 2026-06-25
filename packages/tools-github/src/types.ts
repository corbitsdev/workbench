import { type } from "arktype";

export const GitHubRepo = type({
  full_name: "string",
  html_url: "string",
  "description?": "string | undefined",
  stargazers_count: "number",
  pushed_at: "string",
});
export type GitHubRepo = typeof GitHubRepo.infer;

export const GitHubIssueOrPR = type({
  html_url: "string",
  title: "string",
  comments: "number",
  reactions: {
    total_count: "number",
  },
  updated_at: "string",
});
export type GitHubIssueOrPR = typeof GitHubIssueOrPR.infer;

export const GitHubSearchReposResponse = type({
  items: GitHubRepo.array(),
});
export type GitHubSearchReposResponse = typeof GitHubSearchReposResponse.infer;

export const GitHubSearchIssuesResponse = type({
  items: GitHubIssueOrPR.array(),
});
export type GitHubSearchIssuesResponse =
  typeof GitHubSearchIssuesResponse.infer;
