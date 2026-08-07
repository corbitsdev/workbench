// The two product tables the signed structure doc grants @corbits/chat:
// per-channel settings and per-principal read cursors. Everything else
// tenancy-shaped — membership, principals, grants — stays native
// platform schema under vendor/intx/db; these tables hold no tenancy
// semantics of their own, only chat's own state, keyed by tenant.
import {
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Settings for a single channel, record-as-truth: `settings` is a
 * namespaced jsonb blob (`"chat/..."` keys plus extension namespaces)
 * rather than a column per setting, so new settings never require a
 * migration.
 */
export const channelSettings = pgTable(
  "channel_settings",
  {
    tenantId: text("tenant_id").notNull(),
    channelId: text("channel_id").notNull(),
    settings: jsonb("settings").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.channelId] })],
);

/**
 * Per-principal read cursor for a channel — humans and agents alike,
 * since both are principals on the platform. `channelId` is the
 * workflow-run/instance id that identifies the channel.
 */
export const channelReadState = pgTable(
  "channel_read_state",
  {
    tenantId: text("tenant_id").notNull(),
    channelId: text("channel_id").notNull(),
    principalId: text("principal_id").notNull(),
    lastSeenCreatedAt: timestamp("last_seen_created_at", {
      withTimezone: true,
    }).notNull(),
    lastSeenId: text("last_seen_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.channelId, table.principalId],
    }),
  ],
);
