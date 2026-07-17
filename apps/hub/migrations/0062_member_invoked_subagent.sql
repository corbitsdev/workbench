-- CL-3686: record which Myra thread (conversation) invoked each subagent so the
-- chat side panel can list subagents scoped to the open thread. One row per
-- (tenant, member, origin conversation, subagent mapping); upserted on each
-- invoke_agent call. Workbench-owned only.

CREATE TABLE IF NOT EXISTS "member_invoked_subagent" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "member_principal_id" text NOT NULL,
  "origin_conversation_id" text NOT NULL,
  "subagent_mapping_id" text NOT NULL,
  "first_invoked_at" timestamp NOT NULL DEFAULT now(),
  "last_invoked_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "member_invoked_subagent_origin_subagent_uniq"
  ON "member_invoked_subagent" (
    "tenant_id",
    "member_principal_id",
    "origin_conversation_id",
    "subagent_mapping_id"
  );