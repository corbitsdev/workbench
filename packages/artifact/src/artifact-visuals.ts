// Presentation mapping for the artifact gallery. The package returns clean
// domain data; this module decides how to visualize it. Maps an artifact
// `kind` to a gallery tile's label, fill color, and grid span. This is the
// single source of truth for kind labels — apps/web's detail-page label
// (`resolveKindLabel`) defers to `explicitVisualForKind` so the card chip and
// the detail header never disagree.

import type { ArtifactWithSession } from "@workbench/shared";
import {
  isLinkedInPostArtifactKind,
  LINKEDIN_POST_ARTIFACT_KINDS,
} from "./artifact-kinds";
import {
  artifactPreviewFamily,
  comparisonSummary,
  previewExcerpt,
} from "./artifact-preview-family";
import { GalleryArtifactParseError, parseGalleryArtifact } from "./types";
import type { ArtifactVisual, GalleryArtifact } from "./types";

// Default visuals per known artifact kind. The DB `kind` column is free-form,
// so unknown kinds fall back to a neutral document tile.
const LINKEDIN_POST_VISUAL: ArtifactVisual = {
  label: "LinkedIn Post",
  fill: "bg-blue",
  span: "row-span-2",
  experimentalFill: "bg-blue/85",
  experimentalSpan: "row-span-2",
};

const REPORT_VISUAL: ArtifactVisual = {
  label: "Report",
  fill: "bg-charcoal",
  span: "row-span-4",
  experimentalFill: "bg-charcoal/90",
  experimentalSpan: "row-span-4",
};

const PRESENTATION_VISUAL: ArtifactVisual = {
  label: "Presentation",
  fill: "bg-charcoal",
  span: "row-span-4",
  experimentalFill: "bg-charcoal/90",
  experimentalSpan: "row-span-4",
};

const COMPARISON_VISUAL: ArtifactVisual = {
  label: "Comparison",
  fill: "bg-green",
  span: "row-span-3",
  experimentalFill: "bg-green/85",
  experimentalSpan: "row-span-3",
};

const KIND_VISUALS: Record<string, ArtifactVisual> = {
  email: {
    label: "Email",
    fill: "bg-orange",
    span: "row-span-3",
    experimentalFill: "bg-orange/85",
    experimentalSpan: "row-span-3",
  },
  "twitter-post": {
    label: "Tweet",
    fill: "bg-blue",
    span: "row-span-2",
    experimentalFill: "bg-blue/85",
    experimentalSpan: "row-span-2",
  },
  "founder-pov-post": {
    label: "Founder POV",
    fill: "bg-blue",
    span: "row-span-2",
    experimentalFill: "bg-blue/85",
    experimentalSpan: "row-span-2",
  },
  "one-pager": {
    label: "One-Pager",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  blog: {
    label: "Blog Post",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "case-study": {
    label: "Case Study",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "case-study-draft": {
    label: "Case Study",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "objection-handling": {
    label: "Objection Handling",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "objection-handling-doc": {
    label: "Objection Handling",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "customer-quotes": {
    label: "Customer Quotes",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "customer-quote-pulls": {
    label: "Customer Quotes",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "sales-one-pager": {
    label: "Sales One-Pager",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "pain-points-blog": {
    label: "Pain Points Blog",
    fill: "bg-charcoal",
    span: "row-span-4",
    experimentalFill: "bg-charcoal/90",
    experimentalSpan: "row-span-4",
  },
  "follow-up-email": {
    label: "Follow-up Email",
    fill: "bg-orange",
    span: "row-span-3",
    experimentalFill: "bg-orange/85",
    experimentalSpan: "row-span-3",
  },
  "ab-comparison": COMPARISON_VISUAL,
  presentation: PRESENTATION_VISUAL,
  gamma_presentation: PRESENTATION_VISUAL,
  "csv-export": {
    label: "CSV",
    fill: "bg-orange",
    span: "row-span-2",
    experimentalFill: "bg-orange/85",
    experimentalSpan: "row-span-2",
  },
  file: {
    label: "File",
    fill: "bg-cream",
    span: "row-span-2",
    experimentalFill: "bg-cream",
    experimentalSpan: "row-span-2",
  },
  selection: {
    label: "Selection",
    fill: "bg-cream",
    span: "row-span-2",
    experimentalFill: "bg-cream",
    experimentalSpan: "row-span-2",
  },
  battlecard: {
    label: "Battlecard",
    fill: "bg-green",
    span: "row-span-3",
    experimentalFill: "bg-green/85",
    experimentalSpan: "row-span-3",
  },
  "pain-points": {
    label: "Pain Points",
    fill: "bg-orange",
    span: "row-span-3",
    experimentalFill: "bg-orange/85",
    experimentalSpan: "row-span-3",
  },
  "call-transcript": {
    label: "Transcript",
    fill: "bg-cream",
    span: "row-span-4",
    experimentalFill: "bg-cream",
    experimentalSpan: "row-span-4",
  },
  web: {
    label: "Web page",
    fill: "bg-blue",
    span: "row-span-4",
    experimentalFill: "bg-blue/85",
    experimentalSpan: "row-span-4",
  },
  web_site: {
    label: "Web page",
    fill: "bg-blue",
    span: "row-span-4",
    experimentalFill: "bg-blue/85",
    experimentalSpan: "row-span-4",
  },
  image: {
    label: "Image",
    fill: "bg-blue",
    span: "row-span-3",
    experimentalFill: "bg-blue/85",
    experimentalSpan: "row-span-3",
  },
  // The workflow's persisted `research` kind, the generic `report` kind, and
  // the heartbeat's stable `morning-brief` kind (CL-3503) share one tile
  // treatment.
  research: REPORT_VISUAL,
  report: REPORT_VISUAL,
  "morning-brief": REPORT_VISUAL,
};

const FALLBACK_VISUAL: ArtifactVisual = {
  label: "Document",
  fill: "bg-cream",
  span: "row-span-3",
  experimentalFill: "bg-cream",
  experimentalSpan: "row-span-3",
};

/**
 * The visual for a kind that is explicitly known to this module (a LinkedIn
 * variant or a `KIND_VISUALS` entry), or undefined for anything else. This is
 * the vocabulary other surfaces (e.g. apps/web's detail-page label) should
 * defer to, rather than each maintaining its own kind → label table.
 */
export function explicitVisualForKind(kind: string): ArtifactVisual | undefined {
  if (isLinkedInPostArtifactKind(kind)) {
    return LINKEDIN_POST_VISUAL;
  }
  return KIND_VISUALS[kind];
}

/** Every kind with an explicit visual/label — the domain over which the
 * card-chip and detail-header labels are guaranteed to agree. */
export const KNOWN_ARTIFACT_KINDS: readonly string[] = [
  ...LINKEDIN_POST_ARTIFACT_KINDS,
  ...Object.keys(KIND_VISUALS),
];

export function visualForKind(kind: string): ArtifactVisual {
  return explicitVisualForKind(kind) ?? FALLBACK_VISUAL;
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

// A session-less workflow artifact has no agent session to name it. The
// producing workflow may instead supply a generic `source.jobLabel` string;
// surface that. No workflow-specific knowledge lives here — the label is the
// domain's to choose. When neither is present, return undefined rather than
// inventing filler text — the source kind is already shown via another badge.
function artifactJobLabel(artifact: ArtifactWithSession): string | undefined {
  if (artifact.sessionName) return artifact.sessionName;
  const source = artifact.source;
  if (source !== null && source !== undefined && typeof source === "object") {
    const label = (source as Record<string, unknown>).jobLabel;
    if (typeof label === "string" && label.trim().length > 0) {
      return label;
    }
  }
  return undefined;
}

// Two initials from a real name (e.g. "Jane Doe" -> "JD"); a single-word name
// yields its first letter only.
export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

// The creator-initials badge is a "someone else made this" signal, never a
// self-reference: it renders only when the artifact's owner is known, named,
// and distinct from the viewer. `viewerPrincipalId` absent means the caller
// has not identified a viewer (e.g. an unauthenticated/system render), so the
// badge is suppressed rather than guessed.
function creatorInitialsFor(
  artifact: ArtifactWithSession,
  viewerPrincipalId: string | undefined,
): string | undefined {
  if (viewerPrincipalId === undefined) return undefined;
  if (artifact.ownerPrincipalId === null) return undefined;
  if (artifact.ownerPrincipalId === viewerPrincipalId) return undefined;
  if (!artifact.ownerName) return undefined;
  const initials = initialsFromName(artifact.ownerName);
  return initials.length > 0 ? initials : undefined;
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

export type ToGalleryArtifactOptions = {
  thumbnailUrl?: string | undefined;
  thumbnailAlt?: string | undefined;
  /** The viewing user's principal id, used to suppress the creator-initials badge on their own artifacts. */
  viewerPrincipalId?: string | undefined;
};

export function toGalleryArtifact(
  artifact: ArtifactWithSession,
  options: ToGalleryArtifactOptions = {},
): GalleryArtifact {
  const visual = visualForKind(artifact.kind);
  const provenance = artifactProvenance(artifact.source);
  const family = artifactPreviewFamily(artifact.kind);
  const excerpt =
    family === "comparison"
      ? (comparisonSummary(artifact.content) ??
        previewExcerpt(artifact.content, { fallbackTitle: artifact.title }))
      : previewExcerpt(artifact.content, { fallbackTitle: artifact.title });
  const from = artifactJobLabel(artifact);
  const creatorInitials = creatorInitialsFor(
    artifact,
    options.viewerPrincipalId,
  );
  return parseGalleryArtifact({
    ...visual,
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    ...(from !== undefined ? { from } : {}),
    time: formatRelativeTime(artifact.updatedAt),
    provenance: provenance.label,
    provenanceTone: provenance.tone,
    status: artifact.status,
    ...(excerpt.length > 0 ? { previewExcerpt: excerpt } : {}),
    ...(options.thumbnailUrl !== undefined
      ? { thumbnailUrl: options.thumbnailUrl }
      : {}),
    ...(options.thumbnailAlt !== undefined
      ? { thumbnailAlt: options.thumbnailAlt }
      : {}),
    ...(creatorInitials !== undefined ? { creatorInitials } : {}),
  });
}

/**
 * Containment wrapper for gallery rendering: an artifact that fails the
 * GalleryArtifact schema is dropped (returns undefined) so one corrupt row
 * can never blank the whole gallery view.
 */
export function tryToGalleryArtifact(
  artifact: ArtifactWithSession,
  options: ToGalleryArtifactOptions = {},
): GalleryArtifact | undefined {
  try {
    return toGalleryArtifact(artifact, options);
  } catch (error) {
    if (error instanceof GalleryArtifactParseError) return undefined;
    throw error;
  }
}
