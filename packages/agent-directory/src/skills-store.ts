// Persistence for the one table this package owns: which skill names a
// hand-authored agent definition has pinned, keyed by the definition's
// stable asset id. Kept apart from route wiring the same way
// `@corbits/config-profiles`' `store.ts` separates persistence from
// `routes.ts`. `DefinitionSkillsStore` is the seam `./routes.ts` and
// `./workflow-capability-routes.ts` depend on; `createDrizzleDefinitionSkillsStore`
// is its one production implementation, over the table in `./schema.ts`.
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { type } from "arktype";

import { definitionSkills } from "./schema";

export type DefinitionSkillsDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

/** Parses `skills` jsonb read back out of the
 * `agent_directory.definition_skills` table (see `./schema.ts`) — the DB
 * is untrusted the same as any other external boundary, so a row's
 * `skills` column is arktype-parsed on the way out rather than `as`-cast,
 * and a malformed row fails loud instead of silently masquerading as a
 * well-formed `string[]`. */
const SkillNamesSchema = type("string[]");

function parseSkills(raw: unknown): readonly string[] {
  const parsed = SkillNamesSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `definition_skills row has malformed skills: ${parsed.summary}`,
    );
  }
  return parsed;
}

export interface DefinitionSkillsStore {
  /** A definition with no row yet — one that has never had skills
   * attached — reads as "no skills attached", not an error. */
  getSkills(assetId: string): Promise<readonly string[]>;
  setSkills(assetId: string, skills: readonly string[]): Promise<void>;
}

export function createDrizzleDefinitionSkillsStore<
  TSchema extends Record<string, unknown>,
>(db: DefinitionSkillsDb<TSchema>): DefinitionSkillsStore {
  return {
    async getSkills(assetId) {
      const [row] = await db
        .select()
        .from(definitionSkills)
        .where(eq(definitionSkills.assetId, assetId))
        .limit(1);
      return row === undefined ? [] : parseSkills(row.skills);
    },

    async setSkills(assetId, skills) {
      const now = new Date();
      await db
        .insert(definitionSkills)
        .values({ assetId, skills: [...skills], updatedAt: now })
        .onConflictDoUpdate({
          target: definitionSkills.assetId,
          set: { skills: [...skills], updatedAt: now },
        });
    },
  };
}

/**
 * An in-memory `DefinitionSkillsStore`, for tests that want the seam
 * without a database. Not a supported deployment target.
 */
export function createInMemoryDefinitionSkillsStore(): DefinitionSkillsStore {
  const rows = new Map<string, readonly string[]>();

  return {
    async getSkills(assetId) {
      return rows.get(assetId) ?? [];
    },
    async setSkills(assetId, skills) {
      rows.set(assetId, [...skills]);
    },
  };
}
