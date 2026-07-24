-- Durable work-unit queue (WQ.2 / CL-4072).
-- Claim path uses FOR UPDATE SKIP LOCKED + lease_until (visibility timeout).
-- Expired leases reclaim on the next claim — no separate sweeper.

CREATE TABLE IF NOT EXISTS "work_unit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "kind" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 8,
  "next_attempt_at" timestamp NOT NULL DEFAULT now(),
  "lease_owner" text,
  "lease_until" timestamp,
  "last_error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "work_unit_status_check" CHECK (
    "status" IN ('pending', 'leased', 'done', 'dead')
  ),
  CONSTRAINT "work_unit_attempts_nonneg" CHECK ("attempts" >= 0),
  CONSTRAINT "work_unit_max_attempts_pos" CHECK ("max_attempts" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "work_unit_tenant_kind_key_uniq"
  ON "work_unit" ("tenant_id", "kind", "idempotency_key");

-- Claim path: pending due, or leased with expired lease.
CREATE INDEX IF NOT EXISTS "work_unit_claim_idx"
  ON "work_unit" ("status", "next_attempt_at", "lease_until");

CREATE INDEX IF NOT EXISTS "work_unit_kind_status_idx"
  ON "work_unit" ("kind", "status");
