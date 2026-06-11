export type GitHubRepo = {
  full_name: string;
  html_url: string;
  description: string | undefined;
  stargazers_count: number;
  pushed_at: string;
};

export type GitHubPR = {
  html_url: string;
  title: string;
  reactions: {
    total_count: number;
  };
  created_at: string;
};

export type GitHubSearchReposResponse = {
  items: GitHubRepo[];
};

export type GitHubSearchIssuesResponse = {
  items: GitHubPR[];
};
