import { type } from "arktype";

export const RedditTopComment = type({
  text: "string",
  "author?": "string",
  score: "number",
});
export type RedditTopComment = typeof RedditTopComment.infer;

export const RedditPost = type({
  id: "string",
  title: "string",
  url: "string",
  permalink: "string",
  created_utc: "number",
  ups: "number",
  num_comments: "number",
  subreddit: "string",
  "topComments?": RedditTopComment.array(),
});
export type RedditPost = typeof RedditPost.infer;
