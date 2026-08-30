// The one product table `@corbits/inbox` owns: `@corbits/mailbox`'s
// enrichment only supports `priority`/`classification`/`status` (see
// `enrichMailboxMessage`'s `MailboxEnrichment`), so there is no column
// there to hold a snooze's `until` timestamp. This table is that column,
// keyed to the same (tenantId, principalId, messageId) scope every
// mailbox mutation uses. Lives in its own `inbox` Postgres schema, never
// `public` — see docs/package-migrations.md and the same pattern in
// `@workbench/onboarding`'s `schema.ts`.
import { pgSchema, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const inboxSchema = pgSchema("inbox");

export const inboxSnooze = inboxSchema.table(
  "snooze",
  {
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    messageId: text("message_id").notNull(),
    until: timestamp("until", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.principalId, table.messageId],
    }),
  ],
);

export type InboxSnoozeRow = typeof inboxSnooze.$inferSelect;
