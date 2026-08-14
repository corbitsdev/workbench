// The one product table this package owns: bookkeeping for one attempt
// stream per (mail row, sink). It is deliberately not an event bus — the
// durable fact is always the mail row itself, and a row here only records
// whether a copy of that mail made it to one external place yet. Lives
// in its own `notify` Postgres schema, fully siloed from the platform's
// `public` schema — see docs/package-migrations.md.
import { index, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const notifySchema = pgSchema("notify");

export const notifyDispatch = notifySchema.table(
  "notify_dispatch",
  {
    id: text("id").primaryKey(),
    mailboxRowId: text("mailbox_row_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    sinkName: text("sink_name").notNull(),
    status: text("status", {
      enum: ["pending", "delivered", "failed", "dead"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("notify_dispatch_due_idx").on(t.status, t.nextAttemptAt)],
);
