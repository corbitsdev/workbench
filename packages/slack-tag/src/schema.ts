// The one product table `@corbits/slack-tag` owns: which workbench
// channel a Slack channel is bound to. Lives in its own `slack_tag`
// Postgres schema, fully siloed from the platform's `public` schema —
// see docs/package-migrations.md.
//
// Keyed by (tenant_id, slack_channel_id), not by a Slack team/workspace
// id: `corbits-tag`'s `TagEvent` carries no team id (one Slack app
// install — one bot token — is mounted against exactly one workbench
// tenant, matching the "being in the channel IS the authorization"
// trust model documented in `../src/principal-resolver.ts`), so the
// tenant a mount is configured for is itself the isolation boundary
// between two Slack workspaces. Two mounts configured with different
// `tenantId`s can never resolve each other's bindings even if their
// Slack channel ids happened to collide.
import { pgSchema, text, timestamp, unique } from "drizzle-orm/pg-core";

export const slackTagSchema = pgSchema("slack_tag");

export const slackChannelBinding = slackTagSchema.table(
  "slack_channel_binding",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    slackChannelId: text("slack_channel_id").notNull(),
    channelId: text("channel_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("slack_channel_binding_tenant_channel_key").on(
      table.tenantId,
      table.slackChannelId,
    ),
  ],
);

export type SlackChannelBindingRow = typeof slackChannelBinding.$inferSelect;
