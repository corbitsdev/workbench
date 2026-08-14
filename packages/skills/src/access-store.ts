// Drizzle-backed `SkillAccessStore` over `skills.skill_access`.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import type { DB } from "@intx/db";

import {
  skillAccessScopeSchema,
  type SkillAccessRow,
  type SkillAccessStore,
} from "./access";
import { skillAccess } from "./schema";

/**
 * `scope` is stored as plain text so the schema stays portable; parse it
 * back through arktype on the way out rather than asserting, so a row
 * hand-edited to an unknown scope fails loudly here instead of silently
 * widening a private skill.
 */
function rowToAccess(row: typeof skillAccess.$inferSelect): SkillAccessRow {
  const scope = skillAccessScopeSchema(row.scope);
  if (scope instanceof type.errors) {
    throw new Error(
      `skill_access row ${row.assetId} carries an unknown scope ${JSON.stringify(row.scope)}`,
    );
  }
  return {
    assetId: row.assetId,
    tenantId: row.tenantId,
    skillName: row.skillName,
    creatorPrincipalId: row.creatorPrincipalId,
    scope,
  };
}

export function createDrizzleSkillAccessStore(db: DB["db"]): SkillAccessStore {
  return {
    async upsert(row) {
      const now = new Date();
      await db
        .insert(skillAccess)
        .values({
          assetId: row.assetId,
          tenantId: row.tenantId,
          skillName: row.skillName,
          creatorPrincipalId: row.creatorPrincipalId,
          scope: row.scope,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: skillAccess.assetId,
          set: {
            tenantId: row.tenantId,
            skillName: row.skillName,
            creatorPrincipalId: row.creatorPrincipalId,
            scope: row.scope,
            updatedAt: now,
          },
        });
    },
    async get(assetId) {
      const rows = await db
        .select()
        .from(skillAccess)
        .where(eq(skillAccess.assetId, assetId))
        .limit(1);
      const found = rows[0];
      return found === undefined ? null : rowToAccess(found);
    },
    async listForTenant(tenantId) {
      const rows = await db
        .select()
        .from(skillAccess)
        .where(eq(skillAccess.tenantId, tenantId));
      return rows.map(rowToAccess);
    },
    async remove(assetId) {
      await db.delete(skillAccess).where(eq(skillAccess.assetId, assetId));
    },
  };
}
