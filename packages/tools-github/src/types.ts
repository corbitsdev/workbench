export type GitHubRepo = {
  full_name: string;
  html_url: string;
  description: string | undefined;
  stargazers_count: number;
  pushed_at: string;
};

export type GitHubIssueOrPR = {
  html_url: string;
  title: string;
  comments: number;
  reactions: {
    total_count: number;
  };
  updated_at: string;
};

export type GitHubSearchReposResponse = {
  items: GitHubRepo[];
};

export type GitHubSearchIssuesResponse = {
  items: GitHubIssueOrPR[];
};
