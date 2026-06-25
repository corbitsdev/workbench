// Artifact domain + presentation types for @workbench/artifact.
//
// Domain shapes (Artifact, ArtifactWithSession, ArtifactVersion, etc.) are
// owned by @workbench/shared and re-exported here so consumers can pull both
// the data model and its UI from one package. Presentation types (VizKind,
// ArtifactVisual, GalleryArtifact) live here because they describe how the
// package renders artifacts, not how they are stored.

import { type } from "arktype";

export type {
  Artifact,
  ArtifactStatus,
  ArtifactVersion,
  ArtifactWithSession,
  ArtifactWithVersions,
  ArtifactKind,
} from "@workbench/shared";

// VizKind is a presentation-internal union used only within this package to
// index tile visuals. It is not serialized across any API boundary, so it
// stays as a plain type alias.
export type VizKind =
  | "bars"
  | "donut"
  | "grid"
  | "lines"
  | "nodes"
  | "heat"
  | "deck"
  | "cal";

export const ArtifactVisualSchema = type({
  label: "string",
  viz: "'bars'|'donut'|'grid'|'lines'|'nodes'|'heat'|'deck'|'cal'",
  fill: "string",
  span: "string",
});

export type ArtifactVisual = typeof ArtifactVisualSchema.infer;

export const GalleryArtifactSchema = type({
  label: "string",
  viz: "'bars'|'donut'|'grid'|'lines'|'nodes'|'heat'|'deck'|'cal'",
  fill: "string",
  span: "string",
  id: "string",
  title: "string",
  from: "string",
  time: "string",
});

export type GalleryArtifact = typeof GalleryArtifactSchema.infer;

export function parseGalleryArtifact(raw: unknown): GalleryArtifact {
  const result = GalleryArtifactSchema(raw);
  if (result instanceof type.errors) {
    throw new Error(`GalleryArtifact: ${result.summary}`);
  }
  return result;
}
