// Maps artifact kinds to one of eight gallery/detail preview families (CL-3515).
// Families drive card chrome, icons, and excerpt shaping — not storage shape.

import { parseComparisonResult } from "@workbench/ui";
import {
  isLinkedInPostArtifactKind,
  usesSocialPostPreview,
} from "./artifact-kinds";
import { cleanContentForExcerpt } from "./artifact-content-clean";

export const ARTIFACT_PREVIEW_FAMILIES = [
  "document",
  "social",
  "email",
  "research",
  "comparison",
  "presentation",
  "data",
  "web",
] as const;

export type ArtifactPreviewFamily = (typeof ARTIFACT_PREVIEW_FAMILIES)[number];

const DOCUMENT_KINDS = new Set([
  "one-pager",
  "sales-one-pager",
  "blog",
  "pain-points-blog",
  "case-study",
  "case-study-draft",
  "objection-handling",
  "objection-handling-doc",
  "customer-quotes",
  "customer-quote-pulls",
  "call-transcript",
]);

const EMAIL_KINDS = new Set(["email", "follow-up-email"]);

const RESEARCH_KINDS = new Set(["research", "report", "morning-brief"]);

const COMPARISON_KINDS = new Set(["ab-comparison"]);

const PRESENTATION_KINDS = new Set(["presentation", "gamma_presentation"]);

const DATA_KINDS = new Set([
  "csv-export",
  "file",
  "image",
  "battlecard",
  "pain-points",
  "selection",
]);

const WEB_KINDS = new Set(["web", "web_site"]);

export function artifactPreviewFamily(kind: string): ArtifactPreviewFamily {
  if (usesSocialPostPreview(kind) || isLinkedInPostArtifactKind(kind)) {
    return "social";
  }
  if (EMAIL_KINDS.has(kind)) return "email";
  if (RESEARCH_KINDS.has(kind)) return "research";
  if (COMPARISON_KINDS.has(kind)) return "comparison";
  if (PRESENTATION_KINDS.has(kind)) return "presentation";
  if (DATA_KINDS.has(kind)) return "data";
  if (WEB_KINDS.has(kind)) return "web";
  if (DOCUMENT_KINDS.has(kind)) return "document";
  return "document";
}

const EXCERPT_MAX = 120;

export interface PreviewExcerptOptions {
  max?: number;
  /** Used when JSON content has no summary/description/title field to surface. */
  fallbackTitle?: string;
}

/**
 * Reduce artifact content to a clean prose excerpt for a gallery card: strip
 * markdown/HTML syntax, resolve JSON through its summary field, collapse
 * whitespace, and cap length. Never dumps raw source syntax on a card.
 */
export function previewExcerpt(
  content: string,
  options: PreviewExcerptOptions = {},
): string {
  const { max = EXCERPT_MAX, fallbackTitle } = options;
  const cleaned = cleanContentForExcerpt(content, fallbackTitle);
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A gallery-card summary line for a comparison artifact: the ranked winner
 * plus how many variants were compared. Returns undefined when `content`
 * does not parse as a `ComparisonResult` (e.g. a legacy or corrupt row), so
 * callers can fall back to the generic prose excerpt rather than surfacing
 * nothing.
 */
export function comparisonSummary(content: string): string | undefined {
  const parsed = parseComparisonResult(content);
  if (!parsed) return undefined;
  const variantCount = parsed.variants.length;
  const variantWord = variantCount === 1 ? "variant" : "variants";
  const winner = parsed.ranking.find((entry) => entry.rank === 1);
  if (!winner) return `${variantCount} ${variantWord}`;
  return `Winner: ${winner.label} · ${variantCount} ${variantWord}`;
}
