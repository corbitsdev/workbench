// The two product tables `@workbench/access-policy` owns: one closed-by-
// default policy row per tenant (`policy`), and a bridge table for
// inviting an email that has no user row yet (`pending_invite`). Both
// live in their own `access_policy` Postgres schema, never `public` —
// see docs/package-migrations.md. Tenancy, principals, roles, and
// grants stay entirely native (vendor/intx/db); this package never
// declares its own copy of any of them, it only opines on top.
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const accessPolicySchema = pgSchema("access_policy");

export const policy = accessPolicySchema.table("policy", {
  tenantId: text("tenant_id").primaryKey(),
  selfSignup: text("self_signup", {
    enum: ["off", "allowed-domains", "open"],
  })
    .notNull()
    .default("off"),
  // Stored as JSON text rather than a native array column so the
  // literal-SQL migration stays a single portable CREATE TABLE; parsed
  // through the arktype schema in ./types.ts at every read.
  allowedDomains: text("allowed_domains").notNull().default("[]"),
  tenancyCreation: text("tenancy_creation", {
    enum: ["owners", "owners-admins", "none"],
  })
    .notNull()
    .default("owners"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PolicyRow = typeof policy.$inferSelect;

export const pendingInvite = accessPolicySchema.table("pending_invite", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  matchType: text("match_type", { enum: ["email", "domain"] }).notNull(),
  // Lowercased email (matchType "email") or bare domain (matchType
  // "domain"), e.g. "acme.example" with no leading "@".
  value: text("value").notNull(),
  roleId: text("role_id"),
  invitedBy: text("invited_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export type PendingInviteRow = typeof pendingInvite.$inferSelect;
