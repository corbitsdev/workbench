// Mirrors `agent-source-read.ts`/`agent-deploy.ts`'s git path for `kind:
// "skill"` assets, since the stock asset routes carry only metadata.
import { fetchSourceFileOrEmpty } from "./git-fetch";
import { pushSourceTree } from "./git-push";
import { withGitToken } from "./git-token";

export const SKILL_SOURCE_PATH = "SKILL.md";

const READ_TOKEN_LIFETIME_MS = 10 * 60 * 1000;
const PUSH_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

function skillAssetUrl(tenantId: string, assetName: string): string {
  return new URL(
    `/api/tenants/${encodeURIComponent(tenantId)}/assets/skill/${assetName}.git`,
    globalThis.location.origin,
  ).toString();
}

/** Returns `""` for a fresh asset or one whose `main` lacks `SKILL.md` —
 * neither is an error, both render an empty editor. */
export async function readSkillSource(
  tenantId: string,
  assetId: string,
  assetName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return withGitToken({
    tenantId,
    assetId,
    actions: ["can_read"],
    lifetimeMs: READ_TOKEN_LIFETIME_MS,
    fetchImpl,
    use: (token) =>
      fetchSourceFileOrEmpty({
        url: skillAssetUrl(tenantId, assetName),
        token,
        filepath: SKILL_SOURCE_PATH,
      }),
  });
}

/** Mints a push token and commits `content` as `SKILL.md` on the asset's
 * `main`. Returns the new commit sha. */
export async function writeSkillSource(
  tenantId: string,
  assetId: string,
  assetName: string,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return withGitToken({
    tenantId,
    assetId,
    actions: ["can_read", "can_push"],
    lifetimeMs: PUSH_TOKEN_LIFETIME_MS,
    fetchImpl,
    use: (token) =>
      pushSourceTree({
        url: skillAssetUrl(tenantId, assetName),
        token,
        tree: { [SKILL_SOURCE_PATH]: content },
        message: "Update SKILL.md",
      }),
  });
}
