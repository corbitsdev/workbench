// The one product table this package owns: bookkeeping for one attempt
// stream per (mail row, sink). It is deliberately not an event bus — the
// durable fact is always the mail row itself, and a row here only records
// whether a copy of that mail made it to one external place yet. Lives
// in its own `notify` Postgres schema, fully siloed from the platform's
// `public` schema — see docs/package-migrations.md.
//
// `tenant_id`/`principal_id` are hard foreign keys into Interchange's own
// `tenant`/`principal` tables (CL-8210): a dispatch row can never outlive
// the tenant or principal it was queued for. `hostTenant`/`hostPrincipal`
// below are declared, never migrated, just far enough to carry the FK —
// same pattern as `@corbits/artifacts`'s `src/schema.ts`.
import { index, integer, pgSchema, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const notifySchema = pgSchema("notify");

const hostTenant = pgTable("tenant", { id: text("id").primaryKey() });
const hostPrincipal = pgTable("principal", { id: text("id").primaryKey() });

export const notifyDispatch = notifySchema.table(
  "notify_dispatch",
  {
    id: text("id").primaryKey(),
    mailboxRowId: text("mailbox_row_id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => hostTenant.id, { onDelete: "cascade" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => hostPrincipal.id, { onDelete: "cascade" }),
    sinkName: text("sink_name").notNull(),
    status: text("status", {
      enum: ["pending", "delivered", "failed", "dead"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notify_dispatch_due_idx").on(t.status, t.nextAttemptAt)],
);
