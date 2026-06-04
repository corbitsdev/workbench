// Artifact domain + presentation types for @workbench/artifact.
//
// Domain shapes (Artifact, ArtifactWithSession, ArtifactVersion, etc.) are
// owned by @workbench/shared and re-exported here so consumers can pull both
// the data model and its UI from one package. Presentation types (VizKind,
// ArtifactVisual, GalleryArtifact) live here because they describe how the
// package renders artifacts, not how they are stored.

export type {
  Artifact,
  ArtifactStatus,
  ArtifactVersion,
  ArtifactWithSession,
  CollateralType,
} from '@workbench/shared';

/** Decorative chart glyph drawn behind a gallery tile. */
export type VizKind = 'bars' | 'donut' | 'grid' | 'lines' | 'nodes' | 'heat' | 'deck' | 'cal';

export interface ArtifactVisual {
  /** Short type label shown on the tile. */
  label: string;
  viz: VizKind;
  /** Tailwind background utility for the tile's hero area. */
  fill: string;
  /** Tailwind grid-span utilities. */
  span: string;
}

/** A gallery-ready view of a single artifact, combining domain data + visuals. */
export interface GalleryArtifact extends ArtifactVisual {
  id: string;
  title: string;
  /** "From" label — the originating session/company. */
  from: string;
  /** Human-readable relative time. */
  time: string;
}
