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
 * A `tenant`-scoped skill is visible to every principal in the tenant
 * that can already reach the row; a `private` one only to the principal
 * who created it, tenant notwithstanding — a private skill inherited
 * from a parent stays invisible to everyone in the child but its author.
 *
 * This predicate only ever runs on rows `SkillAssetStore.findByName` and
 * `SkillAccessStore.listForTenant` already resolved, both of which bound
 * their results to the caller's own tenant plus its ancestors (the same
 * chain-walk the native asset resolver uses, see `resolveAssetByName` /
 * `listAssetsForTenant`) — so the tenant boundary is enforced once, at
 * the resolution layer, not duplicated here. This function's whole job
 * is the scope check.
 */
export function isSkillVisibleTo(
  row: SkillAccessRow,
  caller: SkillCaller,
): boolean {
  if (row.scope === "tenant") return true;
  return row.creatorPrincipalId === caller.principalId;
}

/**
 * Only the creating principal, calling from the tenant that owns the
 * skill, may republish, restore, or change its scope. A row inherited
 * from an ancestor tenant is never administerable from a descendant —
 * even by its own author — so writes never touch an ancestor's asset;
 * the registry refuses those explicitly rather than silently forking a
 * copy (see `registry.ts`'s `requireOwnTenant`).
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
