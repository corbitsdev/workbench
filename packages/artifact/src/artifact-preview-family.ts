// Maps artifact kinds to one of eight gallery/detail preview families (CL-3515).
// Families drive card chrome, icons, and excerpt shaping — not storage shape.

import type { ArtifactStatus } from "@workbench/shared";
import {
  isLinkedInPostArtifactKind,
  usesSocialPostPreview,
} from "./artifact-kinds";

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

/** Short, human-readable status for gallery chips. */
export function labelForArtifactStatus(
  status: ArtifactStatus | string,
): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    default:
      return typeof status === "string" && status.length > 0 ? status : "Draft";
  }
}

const EXCERPT_MAX = 120;

/** Collapse whitespace and cap length — never dump full artifact bodies on cards. */
export function previewExcerpt(content: string, max = EXCERPT_MAX): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
