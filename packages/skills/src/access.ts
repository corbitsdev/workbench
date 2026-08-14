// Visibility scoping for registry skills. The verdict is a pure
// function of the access row and the calling principal so it is
// provable without a database; the drizzle-backed row store that feeds
// it lives in `./access-store.ts`.
import { type } from "arktype";

export const skillAccessScopeSchema = type("'private' | 'tenant'");

export type SkillAccessScope = typeof skillAccessScopeSchema.infer;

export type SkillAccessRow = {
  readonly assetId: string;
  readonly tenantId: string;
  readonly skillName: string;
  readonly creatorPrincipalId: string;
  readonly scope: SkillAccessScope;
};

export type SkillCaller = {
  readonly tenantId: string;
  readonly principalId: string;
};

/**
 * A `tenant`-scoped skill is visible to every principal in its own
 * tenant; a `private` one only to the principal who created it. A row
 * from another tenant is never visible, whatever its scope — the
 * registry's list and search paths both funnel through here so neither
 * can grow its own weaker rule.
 */
export function isSkillVisibleTo(
  row: SkillAccessRow,
  caller: SkillCaller,
): boolean {
  if (row.tenantId !== caller.tenantId) return false;
  if (row.scope === "tenant") return true;
  return row.creatorPrincipalId === caller.principalId;
}

/**
 * Only the creating principal may republish, restore, or change the
 * scope of a skill. Reading is scoped by `isSkillVisibleTo`; writing is
 * strictly narrower, so a tenant-shared skill cannot be rewritten by
 * everyone who can read it.
 */
export function canAdministerSkill(
  row: SkillAccessRow,
  caller: SkillCaller,
): boolean {
  return (
    row.tenantId === caller.tenantId &&
    row.creatorPrincipalId === caller.principalId
  );
}

export type SkillAccessStore = {
  upsert(row: SkillAccessRow): Promise<void>;
  get(assetId: string): Promise<SkillAccessRow | null>;
  listForTenant(tenantId: string): Promise<readonly SkillAccessRow[]>;
  remove(assetId: string): Promise<void>;
};
