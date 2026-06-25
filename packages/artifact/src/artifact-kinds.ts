export const LINKEDIN_POST_ARTIFACT_KINDS = [
  "linkedin-post",
  "linkedin-daily",
  "linkedin",
  "pain-points-linkedin-post",
] as const;

export type LinkedInPostArtifactKind =
  (typeof LINKEDIN_POST_ARTIFACT_KINDS)[number];

const LINKEDIN_POST_KIND_SET = new Set<string>(LINKEDIN_POST_ARTIFACT_KINDS);

export function isLinkedInPostArtifactKind(
  kind: string,
): kind is LinkedInPostArtifactKind {
  return LINKEDIN_POST_KIND_SET.has(kind);
}

export const SOCIAL_POST_PREVIEW_KINDS = [
  ...LINKEDIN_POST_ARTIFACT_KINDS,
  "twitter-post",
  "pain-points-twitter-post",
  "founder-pov-post",
] as const;

const SOCIAL_POST_PREVIEW_KIND_SET = new Set<string>(SOCIAL_POST_PREVIEW_KINDS);

export function usesSocialPostPreview(kind: string): boolean {
  return SOCIAL_POST_PREVIEW_KIND_SET.has(kind);
}
