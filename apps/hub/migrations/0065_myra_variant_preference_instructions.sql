-- Per-member standing guidance for Myra (CL-3661): a global instruction plus
-- per-surface (chat/triage) overrides, rendered as a DATA section after the
-- operator/active-context section at prompt-build time. Nullable text;
-- length-validated (4000 chars) at the API boundary, not here.

ALTER TABLE "myra_variant_preference"
  ADD COLUMN IF NOT EXISTS "instructions_global" text,
  ADD COLUMN IF NOT EXISTS "instructions_chat" text,
  ADD COLUMN IF NOT EXISTS "instructions_triage" text;
