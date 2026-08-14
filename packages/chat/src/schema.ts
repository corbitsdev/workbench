// Product tables @corbits/chat owns (see scripts/checks/no-product-tenancy
// ALLOWLIST): channel_settings, channel_read_state, channel_launch,
// channel_tenancy, message_reactions, and pinned_messages. These tables
// live in their own `chat` Postgres schema,
// fully siloed from the platform's `public` schema — see
// docs/package-migrations.md. `tenantId`/`principalId` are plain text
// identifiers, not foreign keys, so referencing platform tenant/principal
// ids works identically from a named schema.
import {
  boolean,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const chatSchema = pgSchema("chat");

/**
 * Settings for a single channel, record-as-truth: `settings` is a
 * namespaced jsonb blob (`"chat/..."` keys plus extension namespaces)
 * rather than a column per setting, so new settings never require a
 * migration.
 */
export const channelSettings = chatSchema.table(
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
export const chatBenchSettings = chatSchema.table("chat_bench_settings", {
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
export const channelReadState = chatSchema.table(
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
export const channelLaunch = chatSchema.table("channel_launch", {
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
export const channelTenancy = chatSchema.table("channel_tenancy", {
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
export const channelThreads = chatSchema.table(
  "channel_threads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    channelId: text("channel_id").notNull(),
    /** root | reply | delivery */
    kind: text("kind").notNull(),
    /** Message id this reply thread answers; null for root/delivery. */
    parentMessageId: text("parent_message_id"),
    /**
     * The thread this one hangs directly off: null for the root
     * thread, the root thread's id for a depth-1 thread, a depth-1
     * thread's id for a depth-2 sub-thread. Two levels, stop — see
     * `resolveThreadAnchor` in `./threads.ts`.
     */
    parentThreadId: text("parent_thread_id"),
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
export const channelThreadMessages = chatSchema.table(
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

/**
 * One poll/form response per principal per block, upsert-on-repeat (see
 * `./block-responses.ts`). `blockId` is the agent-authored `pollId`/`formId`
 * — never unique on its own — so every row is additionally scoped by
 * `messageId`: the block this row answers is the one in *this specific*
 * message, never any other message that happens to reuse the same id.
 */
export const blockResponses = chatSchema.table(
  "block_responses",
  {
    tenantId: text("tenant_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    blockId: text("block_id").notNull(),
    principalId: text("principal_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.channelId,
        table.messageId,
        table.blockId,
        table.principalId,
      ],
    }),
    index("block_responses_block_idx").on(
      table.tenantId,
      table.channelId,
      table.messageId,
      table.blockId,
    ),
  ],
);

/**
 * One row per (tenant, channel, message, emoji, principal) — a
 * principal either has reacted with a given emoji on a given message
 * or hasn't; there is no count column, the row's presence *is* the
 * count (see `./reactions.ts`'s `toggleReaction`, which inserts on a
 * miss and deletes on a hit — true toggle semantics, never an
 * increment/decrement counter that can drift from reality). The
 * natural composite key doubles as the anti-double-react guard: a
 * second `INSERT` for the same five columns can only ever be the same
 * toggle flipping back off.
 */
export const messageReactions = chatSchema.table(
  "message_reactions",
  {
    tenantId: text("tenant_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    emoji: text("emoji").notNull(),
    principalId: text("principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.channelId,
        table.messageId,
        table.emoji,
        table.principalId,
      ],
    }),
    index("message_reactions_message_idx").on(
      table.tenantId,
      table.channelId,
      table.messageId,
    ),
  ],
);

/**
 * One row per pinned message — a message is pinned or it isn't, so
 * this is presence-as-truth the same way `messageReactions` is: no
 * `pinned: boolean` column anywhere, the row's existence is the pin.
 * `pinnedBy`/`pinnedAt` record who pinned it and when for the pinned
 * strip's byline; unpinning deletes the row outright rather than
 * soft-deleting it, since there is no history feature reading pin/unpin
 * churn today.
 */
export const pinnedMessages = chatSchema.table(
  "pinned_messages",
  {
    tenantId: text("tenant_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    pinnedBy: text("pinned_by").notNull(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.channelId, table.messageId],
    }),
    index("pinned_messages_channel_idx").on(table.tenantId, table.channelId),
  ],
);
