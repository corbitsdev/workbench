// Presentation mapping for the artifact gallery. The package returns clean
// domain data; this module decides how to visualize it. Maps an artifact
// `kind` to a gallery tile's label, decorative viz, fill color, and grid span.

import type { ArtifactWithSession } from '@workbench/shared';
import type { ArtifactVisual, GalleryArtifact } from './types';

// Default visuals per known artifact kind. The DB `kind` column is free-form,
// so unknown kinds fall back to a neutral document tile.
const KIND_VISUALS: Record<string, ArtifactVisual> = {
  email: { label: 'Email', viz: 'lines', fill: 'bg-orange', span: 'row-span-3' },
  linkedin: { label: 'Post', viz: 'lines', fill: 'bg-blue', span: 'row-span-2' },
  'one-pager': { label: 'Document', viz: 'deck', fill: 'bg-charcoal', span: 'row-span-4' },
  battlecard: { label: 'Battlecard', viz: 'grid', fill: 'bg-green', span: 'row-span-3' },
};

const FALLBACK_VISUAL: ArtifactVisual = {
  label: 'Document',
  viz: 'lines',
  fill: 'bg-cream',
  span: 'row-span-3',
};

export function visualForKind(kind: string): ArtifactVisual {
  return KIND_VISUALS[kind] ?? FALLBACK_VISUAL;
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  let duration = (then - Date.now()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return RELATIVE_TIME.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return '';
}

export function toGalleryArtifact(artifact: ArtifactWithSession): GalleryArtifact {
  const visual = visualForKind(artifact.kind);
  return {
    ...visual,
    id: artifact.id,
    title: artifact.title,
    from: artifact.sessionName ?? 'Untitled session',
    time: formatRelativeTime(artifact.updatedAt),
  };
}
