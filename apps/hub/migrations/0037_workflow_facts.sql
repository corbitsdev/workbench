-- CL-2670: workflow analytics FACTS. Flat, append-only, REBUILDABLE derived
-- facts (duration / step-type / outcome) projected from a terminal run's native
-- git event log. A pure derived cache — never a run-state mirror, never the DAG.
-- A reproject rebuilds every row from the logs.

CREATE TABLE IF NOT EXISTS "workflow_run_fact" (
  "run_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "kind" text NOT NULL,
  "outcome" text NOT NULL,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "duration_ms" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "workflow_run_fact_tenant_kind_idx"
  ON "workflow_run_fact" ("tenant_id", "kind");

CREATE TABLE IF NOT EXISTS "workflow_step_fact" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "step_id" text NOT NULL,
  "attempt" integer NOT NULL,
  "tenant_id" text NOT NULL,
  "kind" text NOT NULL,
  "step_kind" text NOT NULL,
  "outcome" text NOT NULL,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "duration_ms" bigint,
  "gate_wait_ms" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "workflow_step_fact"
    ADD CONSTRAINT "workflow_step_fact_run_step_attempt"
    UNIQUE ("run_id", "step_id", "attempt");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "workflow_step_fact_tenant_kind_stepkind_idx"
  ON "workflow_step_fact" ("tenant_id", "kind", "step_kind");

CREATE INDEX IF NOT EXISTS "workflow_step_fact_run_idx"
  ON "workflow_step_fact" ("run_id");
