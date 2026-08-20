// The one table `@corbits/agent-directory` owns: which skill names a
// hand-authored agent definition has pinned. Lives in its own
// `agent_directory` Postgres schema, never `public` — see
// docs/package-migrations.md. Moved off a `skills.json` asset-tree
// sidecar (CL-6135): vendor/intx/hub-sessions' `workflow-kind.ts`
// validates a `workflow`-kind asset tree against a hard allowlist of
// `workflow.json`, `capability-declarations.json`, and `.gitignore` — a
// package-owned sidecar file can never be a fourth entry there without
// forking read-only vendor code, so pinned skills are product-owned
// state instead, keyed by the definition's stable asset id.
import { jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const agentDirectorySchema = pgSchema("agent_directory");

/**
 * `skills` is jsonb — a flat array of skill names, record-as-truth like
 * `@corbits/config-profiles`' `profile.entries` — so the pinned-skill
 * list never requires a migration to evolve.
 */
export const definitionSkills = agentDirectorySchema.table(
  "definition_skills",
  {
    assetId: text("asset_id").primaryKey(),
    skills: jsonb("skills").notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type DefinitionSkillsTableRow = typeof definitionSkills.$inferSelect;
