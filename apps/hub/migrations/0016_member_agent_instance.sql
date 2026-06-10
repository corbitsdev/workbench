-- Per-user attribution for agent instances (CL-1532).
--
-- On member join we create a per-user instance of each enabled org-level agent
-- template definition (seeded by CL-1530). Interchange's agent_instance carries
-- no owner-user column, so this workbench-side table records which member
-- principal owns which instance of which template. The unique key keeps the
-- on-join provisioning idempotent and race-safe across replicas.

CREATE TABLE IF NOT EXISTS "member_agent_instance" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "member_principal_id" text NOT NULL,
  "template_key" text NOT NULL,
  "agent_id" text NOT NULL,
  "instance_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "member_agent_instance"
  ADD CONSTRAINT "member_agent_instance_tenant_member_template_uniq"
  UNIQUE ("tenant_id", "member_principal_id", "template_key");
