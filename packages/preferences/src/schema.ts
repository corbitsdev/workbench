// Workbench-owned per-(tenant, principal) UI preference store: one JSONB
// row per user per bench, holding whatever small UI choices a surface wants
// to remember across reload (col2 collapse, theme, ...). Forward-compatible
// on purpose — new keys land in the same row with no migration.
//
// This table lives in its own `preferences` Postgres schema, fully siloed
// from the platform's `public` schema — see docs/package-migrations.md.
// `tenantId`/`principalId` are plain text identifiers, not foreign keys, so
// referencing platform tenant/principal ids works identically from a named
// schema.
import {
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const preferencesSchema = pgSchema("preferences");

export const userPreferences = preferencesSchema.table(
  "user_preferences",
  {
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    data: jsonb("data").notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.principalId] })],
);

export type UserPreferencesRow = typeof userPreferences.$inferSelect;
