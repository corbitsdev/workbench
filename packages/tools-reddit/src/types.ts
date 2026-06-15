export type RedditTopComment = {
  text: string;
  author?: string;
  score: number;
};

export type RedditPost = {
  id: string;
  title: string;
  url: string;
  permalink: string;
  created_utc: number;
  ups: number;
  num_comments: number;
  subreddit: string;
  topComments?: RedditTopComment[];
};
