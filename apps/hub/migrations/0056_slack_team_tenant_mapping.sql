-- Slack workspace (team) → tenant mapping (CL-3629). The webhook receiver
-- previously routed a Slack event by scanning every tenant's members
-- (`firstEnabledTenant`/`routeMention` in webhooks-slack.ts), which only
-- worked for a single Slack workspace per deployment. Written when the owner
-- enables the Slack inbox source (auth.test on the tenant's bot token
-- resolves the team id); the webhook looks up `team_id` from the event
-- envelope against this table and routes to that tenant only. `slack_team_id`
-- is globally unique — one Slack workspace maps to exactly one tenant.

CREATE TABLE IF NOT EXISTS "slack_team_tenant_mapping" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "slack_team_id" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "slack_team_tenant_mapping_team_uniq" UNIQUE ("slack_team_id")
);
