-- CL-4269: idempotency ledger for the generic provider-webhook receiver.
-- `id` is "<provider>:<deliveryId>" (not a generated id) so a retried
-- delivery collides on the primary key instead of needing a
-- lookup-then-insert race. Named for its first caller (the Linear adapter)
-- but the table itself is provider-generic -- see providerWebhookDelivery in
-- apps/hub/src/db/schema.ts.

CREATE TABLE IF NOT EXISTS "provider_webhook_delivery" (
  "id" text PRIMARY KEY,
  "provider" text NOT NULL,
  "delivery_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "tenant_key" text NOT NULL,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "received_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "provider_webhook_delivery_tenant_received_idx"
  ON "provider_webhook_delivery" ("tenant_id", "received_at");
