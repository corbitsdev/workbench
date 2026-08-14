// Who may see which skill. The skill itself — its SKILL.md, its body,
// its whole version history — lives in the native `kind:"skill"` asset's
// git repo, never here; this table carries only the visibility verdict
// the registry applies when listing or searching on behalf of a caller.
//
// Lives in its own `skills` Postgres schema, never `public` (see
// docs/package-migrations.md). `tenantId`, `assetId`, and
// `creatorPrincipalId` are plain text identifiers, not foreign keys, so
// the reference to a platform asset row works identically from a
// package-owned schema.
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const skillsSchema = pgSchema("skills");

/**
 * One row per registry-visible skill asset, keyed by the asset id.
 *
 * `scope` is the whole gate: `private` means only `creatorPrincipalId`
 * sees the skill, `tenant` means every principal in `tenantId` does. A
 * skill asset with no row here is invisible to everyone — a skill is
 * published into the registry by writing this row, so an asset that
 * exists without one can never leak.
 */
export const skillAccess = skillsSchema.table("skill_access", {
  assetId: text("asset_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  skillName: text("skill_name").notNull(),
  creatorPrincipalId: text("creator_principal_id").notNull(),
  scope: text("scope").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
