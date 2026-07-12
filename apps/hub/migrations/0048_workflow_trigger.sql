-- Webhook-triggered workflow runs: a durable per-trigger secret lets
-- an external system fire a workflow run over HTTP without a session.
-- secret_hash is a SHA-256 hash of the trigger secret -- the plaintext is
-- returned to the owner exactly once, at creation, and never stored.

CREATE TABLE IF NOT EXISTS "workflow_trigger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "owner_member_principal_id" text NOT NULL,
  "workflow_kind" text NOT NULL,
  "secret_hash" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "last_fired_at" timestamp
);
