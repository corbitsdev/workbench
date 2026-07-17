-- Per-member Myra catalog tool narrowing (CL-3762): disabled packages and/or
-- individual catalog tool names. Empty arrays mean "no extra narrowing" (full
-- workspace grant set at launch).

ALTER TABLE "myra_variant_preference"
  ADD COLUMN IF NOT EXISTS "disabled_catalog_packages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "disabled_tool_names" jsonb NOT NULL DEFAULT '[]'::jsonb;