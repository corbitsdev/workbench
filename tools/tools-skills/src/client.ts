// the Workbench skill registry (`@corbits/skills`' HTTP surface
// this client used to call, mounted at `/api/workflow-skills`) was
// deleted — skills are native `kind:"skill"` hub assets now, and there is
// no stock Interchange route yet that lets a workflow-run bearer identity
// list a skill's index or read its `SKILL.md` body (the stock asset
// routes in `@intx/hub-api`'s `routes/assets.ts` cover asset metadata —
// id/name/displayName — and package-registry tarballs, but no skill
// content). Rather than vendor a replacement surface or silently degrade
// to "no skills", every call here fails closed with an explicit error
// naming the gap, exactly as this package's own design already commits
// to doing for any registry it cannot reach.
export interface WorkflowSkillsClientConfig {
  readonly hubSkillsUrl: string;
  readonly sidecarToken: string;
  readonly runAddress: string;
}

export type SkillIndexItem = {
  readonly name: string;
  readonly description: string;
};

export type LoadedSkill = SkillIndexItem & { readonly body: string };

const NO_STOCK_SKILL_CONTENT_ROUTE =
  "Skill content has no stock Interchange HTTP route: the " +
  "workbench-specific skills registry that used to serve it was removed, " +
  "and no replacement has been added to @intx/hub-api yet.";

/** Lists every skill the run's principal can see. */
export function listSkills(
  _config: WorkflowSkillsClientConfig,
): Promise<readonly SkillIndexItem[]> {
  return Promise.reject(new Error(NO_STOCK_SKILL_CONTENT_ROUTE));
}

/** Searches the visible skills by name and description. */
export function searchSkills(
  _config: WorkflowSkillsClientConfig,
  _query: string,
): Promise<readonly SkillIndexItem[]> {
  return Promise.reject(new Error(NO_STOCK_SKILL_CONTENT_ROUTE));
}

/** Reads one skill's full instructions. */
export function loadSkill(
  _config: WorkflowSkillsClientConfig,
  _name: string,
): Promise<LoadedSkill> {
  return Promise.reject(new Error(NO_STOCK_SKILL_CONTENT_ROUTE));
}
