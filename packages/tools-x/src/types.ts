import { type } from "arktype";

export const XSearchResult = type({
  title: "string",
  "url?": "string",
  summary: "string",
  "publishedAt?": "string",
  "engagementSignal?": "string",
});

export type XSearchResult = typeof XSearchResult.infer;

export const XSearchResponse = type({
  results: XSearchResult.array(),
});

export type XSearchResponse = typeof XSearchResponse.infer;
