-- Per-member default Myra variant selection (chat + triage). Each column holds
-- a variant id from the @workbench/myra catalog or NULL ("use the canonical
-- default"). A selection only — instances are minted lazily from the selected
-- variant and keep it for life, so changing a row never re-deploys an existing
-- instance. Workbench-owned; no interchange table is touched.

CREATE TABLE IF NOT EXISTS "myra_variant_preference" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "member_principal_id" text NOT NULL,
  "chat_variant_id" text,
  "triage_variant_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "myra_variant_preference_tenant_principal_uniq"
    UNIQUE ("tenant_id", "member_principal_id")
);
