import { type } from "arktype";

// Shared shape for a single command-palette result. The schema is the canonical
// definition so a future server-side palette search can validate and return the
// exact same item shape the client renders. `to` is a client-side route path the
// host navigates to when the item is selected. `keywords`/`subtitle` widen the
// fuzzy-match haystack without appearing as the primary label.
export const PaletteResultCategorySchema = type(
  "'navigation' | 'conversation' | 'agent' | 'workflow' | 'artifact' | 'skill' | 'tool'",
);
export type PaletteResultCategory = typeof PaletteResultCategorySchema.infer;

export const PaletteResultItemSchema = type({
  id: "string",
  category: PaletteResultCategorySchema,
  title: "string",
  "subtitle?": "string",
  to: "string",
  "keywords?": "string[]",
  "requires?": "'admin' | 'owner' | 'admin-or-owner'",
});
export type PaletteResultItem = typeof PaletteResultItemSchema.infer;

// Response shape of the server-side aggregate palette search. Shared so the hub
// route and the web boundary parser validate against one canonical schema. Each
// source contributes at most a fixed number of rows; `hasMore` is true when any
// source had a further page at the requested offset.
export const PaletteSearchResponseSchema = type({
  results: PaletteResultItemSchema.array(),
  page: "number",
  hasMore: "boolean",
});
export type PaletteSearchResponse = typeof PaletteSearchResponseSchema.infer;

export const FuzzyMatchResultSchema = type({
  score: "number",
  // Character indices in the matched text, ascending, for highlight.
  indices: "number[]",
});
export type FuzzyMatchResult = typeof FuzzyMatchResultSchema.infer;

const CONSECUTIVE_BONUS = 4;
const WORD_BOUNDARY_BONUS = 6;
const BASE_HIT = 1;
const TITLE_FIELD_BONUS = 12;

function isBoundaryChar(char: string | undefined): boolean {
  return char === undefined || char === " " || /[-_/.]/.test(char);
}

/**
 * Subsequence fuzzy match: every character of `query` must appear in `text` in
 * order (case-insensitive). Returns null when it does not. Scoring rewards
 * consecutive runs, word-boundary starts, and earlier/shorter matches so an
 * exact prefix outranks a scattered subsequence. A tiny dependency-free matcher
 * is preferred over pulling in Fuse.js/uFuzzy for a v1 client-side palette.
 */
export function fuzzyMatch(
  query: string,
  text: string,
): FuzzyMatchResult | null {
  if (query.length === 0) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let hit = BASE_HIT;
    if (ti === prevMatch + 1) hit += CONSECUTIVE_BONUS;
    if (isBoundaryChar(t[ti - 1])) hit += WORD_BOUNDARY_BONUS;
    score += hit;
    indices.push(ti);
    prevMatch = ti;
    qi++;
  }
  if (qi < q.length) return null;
  score += Math.max(0, 10 - (indices[0] ?? 0));
  score -= t.length * 0.01;
  return { score, indices };
}

export const RankedPaletteItemSchema = type({
  item: PaletteResultItemSchema,
  // Indices into `item.title` to highlight; empty when matched only on
  // subtitle/keywords.
  titleIndices: "number[]",
  score: "number",
});
export type RankedPaletteItem = typeof RankedPaletteItemSchema.infer;

/**
 * Rank items against a query. An empty query returns every item unranked (score
 * 0, no highlight) so the palette shows the full catalog before the user types.
 * Title matches are weighted above subtitle/keyword matches so the most
 * recognizable label wins; only the title's match indices are returned, since
 * that is the field rendered as the row label.
 */
export function rankPaletteItems(
  query: string,
  items: readonly PaletteResultItem[],
): RankedPaletteItem[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return items.map((item) => ({ item, titleIndices: [], score: 0 }));
  }
  const ranked: RankedPaletteItem[] = [];
  for (const item of items) {
    const titleMatch = fuzzyMatch(trimmed, item.title);
    let score = titleMatch
      ? titleMatch.score + TITLE_FIELD_BONUS
      : Number.NEGATIVE_INFINITY;
    const secondary = [item.subtitle, ...(item.keywords ?? [])];
    for (const field of secondary) {
      if (!field) continue;
      const match = fuzzyMatch(trimmed, field);
      if (match && match.score > score) score = match.score;
    }
    if (score > Number.NEGATIVE_INFINITY) {
      ranked.push({ item, titleIndices: titleMatch?.indices ?? [], score });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/** Filter static nav palette entries by their optional `requires` role gate.
 * Server-side nav (Admin/Owner) already re-checks, this is only client visibility.
 * Owner is a superset: an owner principal has both isOwner and isAdmin true. */
export function filterPaletteNavItems(
  items: readonly PaletteResultItem[],
  me: { isAdmin?: boolean; isOwner?: boolean } | undefined,
): PaletteResultItem[] {
  return items.filter((item) => {
    const req = (item as any).requires as
      | "admin"
      | "owner"
      | "admin-or-owner"
      | undefined;
    if (!req) return true;
    if (req === "owner") return !!me?.isOwner;
    if (req === "admin") return !!me?.isAdmin;
    if (req === "admin-or-owner") return !!me?.isAdmin || !!me?.isOwner;
    return true;
  });
}
