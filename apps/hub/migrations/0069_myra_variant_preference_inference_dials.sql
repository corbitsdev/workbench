-- CL-3766 (0069): per-member Creative / Thinking inference dials (0–100, null = model default).
ALTER TABLE "myra_variant_preference"
  ADD COLUMN IF NOT EXISTS "creative_chat" integer,
  ADD COLUMN IF NOT EXISTS "thinking_chat" integer,
  ADD COLUMN IF NOT EXISTS "creative_triage" integer,
  ADD COLUMN IF NOT EXISTS "thinking_triage" integer;