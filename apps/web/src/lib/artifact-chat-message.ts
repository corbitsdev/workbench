import type { ArtifactWithSession } from "@workbench/artifact";

// Hand the agent a reference, not the body: it loads the current content via
// the artifact_read tool, so the chat message stays small and never goes stale.
export function buildArtifactMessage(
  artifact: ArtifactWithSession,
  tenantId?: string,
): string {
  if (artifact.id === "") {
    throw new Error("Cannot reference an artifact with an empty id");
  }
  const tenantClause = tenantId ? ` in tenant ${tenantId}` : "";
  return `I'd like to work with the artifact ${JSON.stringify(artifact.title)} (id: ${artifact.id}${tenantClause}). Load it with artifact_read before responding.`;
}
