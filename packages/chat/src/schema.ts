// Product tables @corbits/chat owns (see scripts/checks/no-product-tenancy
// ALLOWLIST): channel_settings, channel_read_state, channel_launch, and
// channel_tenancy. Tenancy-shaped platform state — membership, principals,
// grants — stays native under vendor/intx/db; these tables hold only chat's
// own state, keyed by tenant.
import {
  boolean,
  index,
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
 * Bench-wide chat defaults — one row per tenant, the same
 * record-as-truth jsonb shape as `channelSettings` (a `"chat/..."`
 * namespaced blob rather than a column per setting). A channel with no
 * override for a given key inherits its value from here; see
 * `resolveContextWindow` in `./channel-settings.ts` for how the two are
 * folded into one effective value.
 */
export const chatBenchSettings = pgTable("chat_bench_settings", {
  tenantId: text("tenant_id").primaryKey(),
  settings: jsonb("settings").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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

/**
 * A thread inside a channel. The root feed is the thread with
 * `kind = 'root'` (one per channel). Reply threads hang off a parent
 * message id; delivery threads hang off a routine run ref. Messages
 * themselves still live in platform mail — this table is workbench
 * thread identity only (see `./threads.ts`).
 */
export const channelThreads = pgTable(
  "channel_threads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    channelId: text("channel_id").notNull(),
    /** root | reply | delivery */
    kind: text("kind").notNull(),
    /** Message id this reply thread answers; null for root/delivery. */
    parentMessageId: text("parent_message_id"),
    /** Routine/run reference for delivery threads; null otherwise. */
    runRef: text("run_ref"),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("channel_threads_channel_idx").on(table.tenantId, table.channelId),
  ],
);

/**
 * Membership of a platform mail message id in a thread. A message
 * belongs to exactly one thread (root feed by default).
 */
export const channelThreadMessages = pgTable(
  "channel_thread_messages",
  {
    tenantId: text("tenant_id").notNull(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id").notNull(),
    messageId: text("message_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.channelId, table.messageId],
    }),
    index("channel_thread_messages_thread_idx").on(
      table.tenantId,
      table.threadId,
    ),
  ],
);
