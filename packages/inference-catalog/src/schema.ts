// The one table this package owns: a bench's model policy. Everything else
// it answers — what a bench can reach, what it costs, which models fit a
// kind of work — is derived at read time from the platform's catalog and
// price history, so there is nothing else to store.
//
// Lives in its own `inference_catalog` Postgres schema, siloed from the
// platform's `public` schema — see docs/package-migrations.md. `tenantId` is
// a plain text identifier, not a foreign key.
import {
  boolean,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const inferenceCatalogSchema = pgSchema("inference_catalog");

export const benchModelPolicy = inferenceCatalogSchema.table(
  "bench_model_policy",
  {
    tenantId: text("tenant_id").primaryKey(),
    allow: text("allow").array().notNull().default([]),
    deny: text("deny").array().notNull().default([]),
    maxInputUsdPerMTok: numeric("max_input_usd_per_mtok"),
    maxOutputUsdPerMTok: numeric("max_output_usd_per_mtok"),
    ceilingIsHard: boolean("ceiling_is_hard").notNull().default(false),
    conceptCeilings: jsonb("concept_ceilings").notNull().default({}),
    providerPreference: jsonb("provider_preference"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type BenchModelPolicyRow = typeof benchModelPolicy.$inferSelect;
