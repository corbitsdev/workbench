// The one product table `@corbits/onboarding` owns: a single pending
// deferred-seed row per (user, tenant), keyed for upsert. Lives in its
// own `onboarding` Postgres schema, never `public` — see
// docs/package-migrations.md. See `./pending-seed.ts` for what the row
// holds and why.
import { pgSchema, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const onboardingSchema = pgSchema("onboarding");

export const pendingSeed = onboardingSchema.table(
  "pending_seed",
  {
    userId: text("user_id").notNull(),
    tenantId: text("tenant_id").notNull(),
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
