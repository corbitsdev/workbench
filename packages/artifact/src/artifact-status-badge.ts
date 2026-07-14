import type { ArtifactStatus } from "@workbench/shared";

// Draft is the default status every artifact starts in, so it carries no
// signal in the UI — only surface the badge for a status that means something
// happened (approved/rejected).
export function shouldShowArtifactStatusBadge(
  status: ArtifactStatus | string,
): boolean {
  return status !== "draft";
}