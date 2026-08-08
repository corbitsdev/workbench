// The two product tables the signed structure doc grants @corbits/chat:
// per-channel settings and per-principal read cursors. Everything else
// tenancy-shaped — membership, principals, grants — stays native
// platform schema under vendor/intx/db; these tables hold no tenancy
// semantics of their own, only chat's own state, keyed by tenant.
import {
  boolean,
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

/**
 * The folded launch body of every instance this package launches —
 * channel hosts and invited agents alike — written in the launch
 * transaction and read back to wake a slept instance. A channel host's
 * definition exists nowhere else (its workflow asset is never pushed
 * a workflow.json), so this row is the single wake-time source for
 * both launch kinds.
 */
export const channelLaunch = pgTable("channel_launch", {
  tenantId: text("tenant_id").notNull(),
  instanceId: text("instance_id").primaryKey(),
  foldedBody: jsonb("folded_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Set at launch time, never re-derived: `true` for a channel host
   * (`launchChannel`), `false` for an invited agent (`launchInvite`).
   * A wake (`wakeByAddress` in `platform-adapter.ts`) reads this to
   * decide whether to pin the noop inference source again or resolve
   * against the tenant catalog — the launch row is the only place
   * that decision is recorded, so a wake never has to re-derive "is
   * this a host" from the asset name or any other proxy.
   */
  noopInference: boolean("noop_inference").notNull().default(false),
});
