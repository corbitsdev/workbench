import { type } from "arktype";

export const HNPost = type({
  objectID: "string",
  title: "string",
  "url?": "string",
  "points?": "number",
  "num_comments?": "number",
  created_at_i: "number",
});

export type HNPost = typeof HNPost.infer;

const HNPostRaw = type({
  objectID: "string | number",
  "title?": "string",
  "url?": "string | null",
  "points?": "number | null",
  "num_comments?": "number | null",
  "created_at_i?": "number",
});

const HNPostRawArray = HNPostRaw.array();

export const HNSearchResponse = type({
  hits: "unknown[]",
}).pipe((raw) => {
  const hits = HNPostRawArray(raw.hits);
  if (hits instanceof type.errors) {
    throw new Error(hits.summary);
  }
  const posts: HNPost[] = hits.map((h) => ({
    objectID: String(h.objectID),
    title: h.title ?? "",
    ...(h.url != null ? { url: h.url } : {}),
    ...(h.points != null ? { points: h.points } : {}),
    ...(h.num_comments != null ? { num_comments: h.num_comments } : {}),
    created_at_i: h.created_at_i ?? 0,
  }));
  return { hits: posts };
});

export type HNSearchResponse = typeof HNSearchResponse.infer;
