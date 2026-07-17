-- Personalization style-axis columns (CL-3760) on myra_variant_preference.
-- `personality` / `emoji_use` / `ui_type` are global; the three usage dials
-- are per-surface (chat vs triage). Each holds an option id from the
-- @workbench/myra style-axes catalog or NULL ("use the axis default" — no
-- prompt overlay text).

ALTER TABLE "myra_variant_preference"
  ADD COLUMN IF NOT EXISTS "personality" text,
  ADD COLUMN IF NOT EXISTS "emoji_use" text,
  ADD COLUMN IF NOT EXISTS "ui_type" text,
  ADD COLUMN IF NOT EXISTS "artifact_usage_chat" text,
  ADD COLUMN IF NOT EXISTS "artifact_usage_triage" text,
  ADD COLUMN IF NOT EXISTS "tool_usage_chat" text,
  ADD COLUMN IF NOT EXISTS "tool_usage_triage" text,
  ADD COLUMN IF NOT EXISTS "skill_usage_chat" text,
  ADD COLUMN IF NOT EXISTS "skill_usage_triage" text;
