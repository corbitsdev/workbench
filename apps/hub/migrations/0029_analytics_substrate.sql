-- CL-2268: workbench-owned analytics substrate. Append-only fact table keyed
-- by a stable event key (idempotent on replay) plus a daily rollup for fast
-- dashboard queries without scanning raw turn/tool history.
CREATE TABLE IF NOT EXISTS "analytics_event" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "principal_id" text,
  "agent_id" text,
  "instance_id" text,
  "session_id" text,
  "turn_id" text,
  "tool_call_id" text,
  "event_key" text NOT NULL,
  "event_type" text NOT NULL,
  "model" text,
  "tool_name" text,
  "status" text,
  "input_tokens" bigint DEFAULT 0 NOT NULL,
  "output_tokens" bigint DEFAULT 0 NOT NULL,
  "cache_read_tokens" bigint DEFAULT 0 NOT NULL,
  "cache_write_tokens" bigint DEFAULT 0 NOT NULL,
  "thinking_tokens" bigint DEFAULT 0 NOT NULL,
  "source" jsonb,
  "metadata" jsonb,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "analytics_event"
  ADD CONSTRAINT "analytics_event_event_key" UNIQUE ("event_key");

CREATE INDEX IF NOT EXISTS "analytics_event_tenant_occurred_at_idx"
  ON "analytics_event" ("tenant_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "analytics_event_instance_occurred_at_idx"
  ON "analytics_event" ("instance_id", "occurred_at");

CREATE TABLE IF NOT EXISTS "analytics_rollup_daily" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "agent_id" text,
  "instance_id" text,
  "model" text,
  "bucket_date" date NOT NULL,
  "rollup_key" text NOT NULL,
  "turn_count" integer DEFAULT 0 NOT NULL,
  "failed_turn_count" integer DEFAULT 0 NOT NULL,
  "tool_call_count" integer DEFAULT 0 NOT NULL,
  "tool_error_count" integer DEFAULT 0 NOT NULL,
  "input_tokens" bigint DEFAULT 0 NOT NULL,
  "output_tokens" bigint DEFAULT 0 NOT NULL,
  "cache_read_tokens" bigint DEFAULT 0 NOT NULL,
  "cache_write_tokens" bigint DEFAULT 0 NOT NULL,
  "thinking_tokens" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "analytics_rollup_daily"
  ADD CONSTRAINT "analytics_rollup_daily_rollup_key" UNIQUE ("rollup_key");

CREATE INDEX IF NOT EXISTS "analytics_rollup_daily_tenant_bucket_idx"
  ON "analytics_rollup_daily" ("tenant_id", "bucket_date");

CREATE INDEX IF NOT EXISTS "analytics_rollup_daily_instance_bucket_idx"
  ON "analytics_rollup_daily" ("instance_id", "bucket_date");
