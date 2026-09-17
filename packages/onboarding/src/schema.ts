// The one product table `@workbench/onboarding` owns: a single pending
// deferred-seed row per (user, tenant), keyed for upsert. Lives in its
// own `onboarding` Postgres schema, never `public` — see
// docs/package-migrations.md. See `./pending-seed.ts` for what the row
// holds and why.
//
// `tenantId` is a hard foreign key into Interchange's own `tenant` table
// (CL-8210) — `hostTenant` below is declared, never migrated, just far
// enough to carry the FK, same pattern as `@corbits/artifacts`'s
// `src/schema.ts`. `userId` is deliberately NOT an FK: it is the
// workbench web app's own better-auth user id (see
// `packages/connections/src/oauth-routes.ts`'s `user.id`), not an
// Interchange principal id, so there is no Interchange row for it to
// reference.
import { pgSchema, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const onboardingSchema = pgSchema("onboarding");

const hostTenant = pgTable("tenant", { id: text("id").primaryKey() });

export const pendingSeed = onboardingSchema.table(
  "pending_seed",
  {
    userId: text("user_id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => hostTenant.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /**
     * `CredentialCipher`-encrypted JSON (`principalId`, `tenantDomain`,
     * `apiKey`) — see `./pending-seed.ts` for the AAD discipline.
     */
    payload: text("payload").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.tenantId] })],
);

export type PendingSeedRow = typeof pendingSeed.$inferSelect;
