// The one product table `@corbits/webhook-triggers` owns: a trigger
// row per external-webhook-to-workflow binding. Tenancy semantics
// (membership, principals, grants) stay native platform schema under
// vendor/intx/db; this table holds only this package's own state,
// keyed by tenant.
//
// The signing secret is stored in plaintext for v1 (see
// `./signature.ts` for the security-model note this trades off) —
// flagged here rather than hidden, since it is the one property of
// this table a security review needs to know first.
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const webhookTrigger = pgTable("webhook_trigger", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  workflowDefinitionId: text("workflow_definition_id").notNull(),
  /**
   * A template applied to the parsed JSON payload to produce the
   * message content the launched run receives — see
   * `./mapping.ts:renderInputTemplate`. Stored as plain jsonb (a
   * single string) rather than a structured mapping language, since
   * `{{path.to.field}}` interpolation is the entire v1 need.
   */
  inputTemplate: text("input_template").notNull(),
  /**
   * The HMAC-SHA256 secret verified against the inbound signature
   * header. Plaintext at rest for v1 — see the module doc on
   * `./signature.ts` — never returned by any route after creation
   * except a rotate response.
   */
  secret: text("secret").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
});

export type WebhookTriggerRow = typeof webhookTrigger.$inferSelect;
