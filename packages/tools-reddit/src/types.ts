export type RedditPost = {
  id: string;
  title: string;
  url: string;
  permalink: string;
  selftext: string;
  created_utc: number;
  ups: number;
  num_comments: number;
  subreddit: string;
};

export type RedditPostData = {
  kind: string;
  data: RedditPost;
};

export type RedditSearchResponse = {
  data: {
    children: RedditPostData[];
  };
};
