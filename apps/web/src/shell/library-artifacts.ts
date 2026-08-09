// The Library page's one seam to the hub's asset store. The hub has no
// dedicated artifact endpoint yet, but it already lists real, tenant-scoped
// assets — workflows, skills, package registries, agent state — at
// `GET /api/tenants/:tenantId/assets`. Each asset is an honest artifact a bench
// owns, so the Library renders them directly rather than staying empty.
//
// This module owns only the AssetRow -> ArtifactSummary mapping, kept pure and
// apart from React so the shape contract has its own test. When a real artifact
// endpoint lands, only this file's body changes; the page above it is already
// wired against `ArtifactSummary`.

import type { ArtifactSummary } from "@corbits/artifact-ui";

import type { AssetRow } from "../api";

/**
 * The display title an asset contributes as an artifact: an author-chosen
 * `displayName` when present, otherwise the kebab `name` the asset is
 * addressed by. Never fabricated.
 */
function assetTitle(asset: AssetRow): string {
  return asset.displayName ?? asset.name;
}

/** One tenant asset, re-shaped into the row the Library page renders. */
export function assetToArtifact(asset: AssetRow): ArtifactSummary {
  return {
    id: asset.id,
    title: assetTitle(asset),
    // Open vocabulary by design (see packages/artifact-ui/src/types.ts): the
    // asset's own kind — "workflow", "skill", "package-registry",
    // "agent-state" — passes straight through so a new asset kind needs no
    // mapping change here.
    kind: asset.kind,
    // The asset response carries a `creatorPrincipalId`, not a display name,
    // so owner is honestly unknown rather than guessed.
    ownerName: null,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

/** Map a full asset listing into artifact rows, preserving order and count. */
export function mapAssetsToArtifacts(
  assets: readonly AssetRow[],
): ArtifactSummary[] {
  return assets.map(assetToArtifact);
}
