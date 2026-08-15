// The narrow port the registry needs over native `kind:"skill"` hub
// assets. Everything the registry stores lives behind it: the asset row,
// the SKILL.md commit, and the asset repo's git history — which IS the
// version store. There is no versions table anywhere in this package.
export type SkillAssetRow = {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly displayName: string | null;
  readonly creatorPrincipalId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** One commit on the skill asset's default ref. */
export type SkillCommit = {
  readonly commitSha: string;
  readonly message: string;
  readonly author: string;
  readonly committedAtIso: string;
};

export type SkillAssetStore = {
  create(input: {
    readonly tenantId: string;
    readonly name: string;
    readonly displayName: string;
    readonly creatorPrincipalId: string;
  }): Promise<SkillAssetRow>;
  findByName(tenantId: string, name: string): Promise<SkillAssetRow | null>;
  listForTenant(tenantId: string): Promise<readonly SkillAssetRow[]>;
  writeSkillMd(input: {
    readonly assetId: string;
    readonly skillName: string;
    readonly contents: string;
    readonly message: string;
  }): Promise<{ readonly commitSha: string }>;
  readSkillMd(input: {
    readonly assetId: string;
    readonly skillName: string;
    readonly commitSha?: string;
  }): Promise<string | null>;
  history(assetId: string): Promise<readonly SkillCommit[]>;
};

/** Path of a skill's SKILL.md inside its own asset tree. */
export function skillMdPath(skillName: string): string {
  return `${skillName}/SKILL.md`;
}
