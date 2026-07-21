-- WQ.3: visibility lease on granola_call_job so process death cannot stick
-- a row in `processing` forever. Claim uses FOR UPDATE SKIP LOCKED + lease_until.

ALTER TABLE "granola_call_job"
  ADD COLUMN IF NOT EXISTS "lease_owner" text,
  ADD COLUMN IF NOT EXISTS "lease_until" timestamp;

-- Reclaim path: processing rows whose lease has expired become claimable again.
CREATE INDEX IF NOT EXISTS "granola_call_job_lease_until_idx"
  ON "granola_call_job" ("status", "lease_until");
