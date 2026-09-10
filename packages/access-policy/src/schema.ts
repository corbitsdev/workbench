// The product table `@workbench/access-policy` owns: one closed-by-
// default policy row per tenant (`policy`). It lives in its own
// `access_policy` Postgres schema, never `public` — see
// docs/package-migrations.md. Tenancy, principals, roles, and grants
// stay entirely native (vendor/intx/db); this package never declares
// its own copy of any of them, it only opines on top.
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
