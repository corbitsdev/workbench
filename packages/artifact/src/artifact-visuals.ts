// Presentation mapping for the artifact gallery. The package returns clean
// domain data; this module decides how to visualize it. Maps an artifact
// `kind` to a gallery tile's label, decorative viz, fill color, and grid span.

import type { ArtifactWithSession } from "@workbench/shared";
import { isLinkedInPostArtifactKind } from "./artifact-kinds";
import { parseGalleryArtifact } from "./types";
import type { ArtifactVisual, GalleryArtifact } from "./types";

// Default visuals per known artifact kind. The DB `kind` column is free-form,
// so unknown kinds fall back to a neutral document tile.
const LINKEDIN_POST_VISUAL: ArtifactVisual = {
  label: "LinkedIn Post",
  viz: "lines",
  fill: "bg-blue",
  span: "row-span-2",
  experimentalFill: "bg-blue/85",
  experimentalSpan: "row-span-2",
};

const REPORT_VISUAL: ArtifactVisual = {
  label: "Report",
  viz: "deck",
  fill: "bg-charcoal",
  span: "row-span-4",
  experimentalFill: "bg-charcoal/90",
  experimentalSpan: "row-span-4",
};

const KIND_VISUALS: Record<string, ArtifactVisual> = {
  email: {
    label: "Email",
    viz: "lines",
    fill: "bg-orange",
    span: "row-span-3",
    experimentalFill: "bg-orange/85",
    experimentalSpan: "row-span-3",
  },
  "twitter-post": {
    label: "Tweet",
    viz: "lines",
    fill: "bg-blue",
    span: "row-span-2",
    experimentalFill: "bg-blue/85",
    experimentalSpan: "row-span-2",
  },
  "founder-pov-post": {
    label: "Founder POV",
    viz: "lines",
    fill: "bg-blue",
    span: "row-span-2",
    experimentalFill: "bg-blue/85",
    experimentalSpan: "row-span-2",
  },
  "one-pager": {
    label: "One-Pager",
    viz: "deck",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  blog: {
    label: "Blog Post",
    viz: "deck",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "case-study": {
    label: "Case Study",
    viz: "deck",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "objection-handling": {
    label: "Objection Handling",
    viz: "deck",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "customer-quotes": {
    label: "Customer Quotes",
    viz: "deck",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  battlecard: {
    label: "Battlecard",
    viz: "grid",
    fill: "bg-green",
    span: "row-span-3",
    experimentalFill: "bg-green/85",
    experimentalSpan: "row-span-3",
  },
  "pain-points": {
    label: "Pain Points",
    viz: "bars",
    fill: "bg-orange",
    span: "row-span-3",
    experimentalFill: "bg-orange/85",
    experimentalSpan: "row-span-3",
  },
  "call-transcript": {
    label: "Transcript",
    viz: "lines",
    fill: "bg-cream",
    span: "row-span-4",
    experimentalFill: "bg-cream",
    experimentalSpan: "row-span-4",
  },
  // Both the workflow's persisted `research` kind and a generic `report` kind
  // share one tile treatment.
  research: REPORT_VISUAL,
  report: REPORT_VISUAL,
};

const FALLBACK_VISUAL: ArtifactVisual = {
  label: "Document",
  viz: "lines",
  fill: "bg-cream",
  span: "row-span-3",
  experimentalFill: "bg-cream",
  experimentalSpan: "row-span-3",
};

export function visualForKind(kind: string): ArtifactVisual {
  if (isLinkedInPostArtifactKind(kind)) {
    return LINKEDIN_POST_VISUAL;
  }
  return KIND_VISUALS[kind] ?? FALLBACK_VISUAL;
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  rejected: "Rejected",
};

export function labelForStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  let duration = (then - Date.now()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return RELATIVE_TIME.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return "";
}

// A session-less workflow artifact has no agent session to name it, so the
// gallery showed "Untitled job". The producing workflow may instead supply a
// generic `source.jobLabel` string; surface that. No workflow-specific knowledge
// lives here — the label is the domain's to choose.
function artifactJobLabel(artifact: ArtifactWithSession): string {
  if (artifact.sessionName) return artifact.sessionName;
  const source = artifact.source;
  if (source !== null && source !== undefined && typeof source === "object") {
    const label = (source as Record<string, unknown>).jobLabel;
    if (typeof label === "string" && label.trim().length > 0) {
      return label;
    }
  }
  return "Untitled job";
}

const ORIGIN_LABELS: Record<string, string> = {
  workflow: "Workflow",
  agent: "Agent",
  manual: "Manual",
  imported: "Imported",
  unknown: "Unknown source",
};

// How a provenance label should be presented:
// - "free": an arbitrary, author-supplied `generatedBy` string — rendered as-is
//   (no forced casing) and truncated, since its length is unbounded.
// - "origin": one of the coarse origin words — safe to uppercase as a chip.
// - "unknown": legacy/unattributed rows — the chip is muted/omitted, not shown
//   as a loud failure-state label.
export type ProvenanceTone = "free" | "origin" | "unknown";

export interface ArtifactProvenance {
  label: string;
  tone: ProvenanceTone;
}

/**
 * The "generated by" provenance attribution. Prefers an explicit `generatedBy`
 * string (free-text), then a label for the coarse `origin`, then a muted
 * unknown state. Always returns a non-empty `label` so callers that surface a
 * badge never silently drop the attribution.
 */
export function artifactProvenance(
  source: ArtifactWithSession["source"],
): ArtifactProvenance {
  if (source !== null && source !== undefined && typeof source === "object") {
    const record = source as Record<string, unknown>;
    const generatedBy = record.generatedBy;
    if (typeof generatedBy === "string" && generatedBy.trim().length > 0) {
      return { label: generatedBy.trim(), tone: "free" };
    }
    const origin = record.origin;
    if (
      typeof origin === "string" &&
      origin in ORIGIN_LABELS &&
      origin !== "unknown"
    ) {
      return { label: ORIGIN_LABELS[origin] as string, tone: "origin" };
    }
  }
  return { label: ORIGIN_LABELS.unknown as string, tone: "unknown" };
}

export function artifactProvenanceLabel(
  source: ArtifactWithSession["source"],
): string {
  return artifactProvenance(source).label;
}

export function toGalleryArtifact(
  artifact: ArtifactWithSession,
): GalleryArtifact {
  const visual = visualForKind(artifact.kind);
  const provenance = artifactProvenance(artifact.source);
  return parseGalleryArtifact({
    ...visual,
    id: artifact.id,
    title: artifact.title,
    from: artifactJobLabel(artifact),
    time: formatRelativeTime(artifact.updatedAt),
    provenance: provenance.label,
    provenanceTone: provenance.tone,
  });
}
