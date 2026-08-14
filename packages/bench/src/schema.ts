// Per-bench purpose and type: benches ARE Interchange tenants (see
// vendor/intx/hub-api/src/routes/tenants.ts), so this is a package-owned
// side-table keyed by tenant id, the same shape `packages/chat/src/schema.ts`'s
// `chat_bench_settings` uses for its own per-bench row — never a column
// added to the vendor `tenant` table.
//
// This table lives in its own `bench` Postgres schema, fully siloed from
// the platform's `public` schema — see docs/package-migrations.md.
// `tenantId` is a plain text identifier, not a foreign key, so referencing
// a platform tenant id works identically from a named schema.
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const benchSchema = pgSchema("bench");

export const benchSettings = benchSchema.table("bench_settings", {
  tenantId: text("tenant_id").primaryKey(),
  /** Free-text description of what the bench is for. Null = never set. */
  purpose: text("purpose"),
  /**
   * The bench's own classification, e.g. "global" or "sub" — the values
   * `BenchCreateType` in `packages/bench-ui/src/create-bench-dialog.tsx`
   * allows today. Left as a free-text column on purpose: arktype validates
   * the known set at the API boundary (see `src/routes.ts`), so the SQL
   * itself never needs a CHECK constraint to stay in sync with that set.
   */
  type: text("type"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type BenchSettingsRow = typeof benchSettings.$inferSelect;
