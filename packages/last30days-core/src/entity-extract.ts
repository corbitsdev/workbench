import { type } from "arktype";

export const EntitySet = type({
  handles: "string[]",
  repos: "string[]",
  subreddits: "string[]",
  hashtags: "string[]",
  keywords: "string[]",
});
export type EntitySet = typeof EntitySet.infer;

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "about",
  "into",
  "than",
  "then",
  "so",
  "as",
  "what",
  "how",
  "why",
]);

export function entityExtract(topic: string): EntitySet {
  const subreddits: string[] = [];
  const handles: string[] = [];
  const repos: string[] = [];
  const hashtags: string[] = [];

  const subredditMatches = topic.matchAll(/\br\/([a-zA-Z0-9_]+)/g);
  for (const match of subredditMatches) {
    if (match[1]) subreddits.push(match[1]);
  }

  const handleMatches = topic.matchAll(/@([a-zA-Z0-9_]+)/g);
  for (const match of handleMatches) {
    if (match[1]) handles.push(match[1]);
  }

  const repoMatches = topic.matchAll(/\b([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)/g);
  for (const match of repoMatches) {
    if (match[1]) repos.push(match[1]);
  }

  const hashtagMatches = topic.matchAll(/#([a-zA-Z0-9_]+)/g);
  for (const match of hashtagMatches) {
    if (match[1]) hashtags.push(match[1]);
  }

  const stripped = topic
    .replace(/\br\/[a-zA-Z0-9_]+/g, "")
    .replace(/@[a-zA-Z0-9_]+/g, "")
    .replace(/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+/g, "")
    .replace(/#[a-zA-Z0-9_]+/g, "");

  const keywords = stripped
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  return { handles, repos, subreddits, hashtags, keywords };
}
