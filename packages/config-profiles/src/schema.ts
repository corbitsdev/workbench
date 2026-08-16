// The one table `@corbits/config-profiles` owns: a named, workspace-level
// pre-built inference configuration (an ordered provider/model fallback
// list with optional restrictions) that can be attached to any workbench
// under this workspace in one action. This table lives in its own
// `config_profiles` Postgres schema, fully siloed from the platform's
// `public` schema — see docs/package-migrations.md. `tenantId` is a plain
// text identifier (the *workspace* tenant that owns the profile, never a
// workbench's own tenant id), not a foreign key, so referencing platform
// tenant ids works identically from a named schema.
import { jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const configProfilesSchema = pgSchema("config_profiles");

/**
 * `entries` is jsonb — record-as-truth, the same convention
 * `@corbits/routines`' `routine.input` uses — so the ordered
 * `{provider, model, disabled?}[]` shape never requires a migration to
 * evolve. A profile is a MACRO over `@corbits/inference-settings`'
 * native catalog writes, never a parallel resolution path: applying it
 * issues the exact same `PATCH .../catalog/offerings/:id` writes a
 * person would make by hand (see `apply.ts`), and this row is never
 * itself read at inference time.
 */
export const configProfile = configProfilesSchema.table("profile", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  entries: jsonb("entries").notNull().default([]),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ConfigProfileTableRow = typeof configProfile.$inferSelect;
