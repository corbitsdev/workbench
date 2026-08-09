// Product tables @corbits/chat owns (see scripts/checks/no-product-tenancy
// ALLOWLIST): channel_settings, channel_read_state, channel_launch, and
// channel_tenancy. Tenancy-shaped platform state — membership, principals,
// grants — stays native under vendor/intx/db; these tables hold only chat's
// own state, keyed by tenant.
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

/**
 * The parent↔child link between a bench and the native tenant a
 * channel was minted as (see `./channel-tenancy.ts`). No native
 * child-tenant listing route exists upstream (`parentId` is stored on
 * `tenant` but never queried by any hub-api route), so this table is
 * the honest source for "which channels are child tenancies of this
 * bench" — chat owns it rather than leaving the question unanswerable.
 * `tenantId` is unique: a channel tenant is minted for exactly one
 * channel, never shared.
 */
export const channelTenancy = pgTable("channel_tenancy", {
  channelId: text("channel_id").primaryKey(),
  tenantId: text("tenant_id").notNull().unique(),
  parentTenantId: text("parent_tenant_id").notNull(),
  slug: text("slug").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
