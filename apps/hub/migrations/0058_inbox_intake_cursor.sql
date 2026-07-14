-- CL-3628: durable inbox intake poll cursor. Replaces the in-process
-- `lastPollAtByScopeKey` map (apps/hub/src/services/inbox-intake.ts) with a
-- persisted row per scope key, so a replica restart resumes from the last
-- successful poll instead of falling back to the full `lookbackMs` window.
-- `scope_key` embeds the tenant/member id already (`member:<principalId>:<source>`
-- or `workspace:<tenantId>:<source>`) so it alone is globally unique; `tenant_id`
-- is carried alongside purely for operator debugging/joins.

CREATE TABLE IF NOT EXISTS "inbox_intake_cursor" (
  "scope_key" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "last_poll_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "inbox_intake_cursor_tenant_idx"
  ON "inbox_intake_cursor" ("tenant_id");
