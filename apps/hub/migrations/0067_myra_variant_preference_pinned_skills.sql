-- Pinned skill ids (CL-3765) on myra_variant_preference: ordered asset ids
-- the member chose from their visible skill library. Validated on write;
-- dangling ids are skipped at prompt-render time.

ALTER TABLE "myra_variant_preference"
  ADD COLUMN IF NOT EXISTS "pinned_skill_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;