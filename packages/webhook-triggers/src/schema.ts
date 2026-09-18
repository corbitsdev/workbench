// The product table `@corbits/webhook-triggers` owns: a trigger row
// per external-webhook-to-workflow binding, living in this package's
// own `webhook_triggers` Postgres schema, fully siloed from the
// platform's `public` schema (see `./migrations.ts`).
//
// `tenant_id` and `created_by` (a real Interchange principal id — see
// `management-routes.ts`'s `createdBy: principal.id`) are hard foreign
// keys into Interchange's own `tenant`/`principal` tables:
// `hostTenant`/`hostPrincipal` below are declared, never migrated,
// just far enough to carry the FK, same pattern as
// `@corbits/artifacts`'s `src/schema.ts`.
//
// The signing secret is encrypted at rest via Interchange's
// `CredentialCipher` seam — see `./store.ts` for the encrypt/decrypt
// wiring and `./signature.ts` for the security-model note on what that
// does and does not close.
import { boolean, pgSchema, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const webhookTriggersSchema = pgSchema("webhook_triggers");

const hostTenant = pgTable("tenant", { id: text("id").primaryKey() });
const hostPrincipal = pgTable("principal", { id: text("id").primaryKey() });

export const webhookTrigger = webhookTriggersSchema.table("webhook_trigger", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => hostTenant.id, { onDelete: "cascade" }),
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
   * header, stored as a `CredentialCipher`-encrypted blob (see
   * `./store.ts`) — never returned by any route after creation except
   * a rotate response, and never in this encrypted form even then.
   */
  secret: text("secret").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by")
    .notNull()
    .references(() => hostPrincipal.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
});

export type WebhookTriggerRow = typeof webhookTrigger.$inferSelect;
