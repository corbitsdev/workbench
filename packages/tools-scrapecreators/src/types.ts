import { type } from "arktype";

export const TikTokPost = type({
  id: "string",
  "url?": "string",
  "desc?": "string",
  "createTime?": "number",
  "likes?": "number",
  "comments?": "number",
  "author?": "string",
});
export type TikTokPost = typeof TikTokPost.infer;

export const InstagramPost = type({
  "code?": "string",
  "caption?": "string",
  "takenAt?": "number | string",
  "likes?": "number",
  "comments?": "number",
  "author?": "string",
});
export type InstagramPost = typeof InstagramPost.infer;

export const ThreadsPost = type({
  "code?": "string",
  "text?": "string",
  "taken_at?": "number",
  "like_count?": "number",
  "user?": { "username?": "string" },
});
export type ThreadsPost = typeof ThreadsPost.infer;

export const PinterestPin = type({
  "id?": "string",
  "title?": "string",
  "description?": "string",
  "created_at?": "string",
  "save_count?": "number",
  "pinner?": { "username?": "string" },
});
export type PinterestPin = typeof PinterestPin.infer;
