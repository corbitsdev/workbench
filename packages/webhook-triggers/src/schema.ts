// Two product tables `@corbits/webhook-triggers` owns: a trigger row
// per external-webhook-to-workflow binding, and a short-lived lease
// row (`repoReviewLease`) closing a concurrency race in the GitHub
// connect card's start-reviewing step (CL-7242, `./repo-review-lease.ts`).
// Both live in this package's own `webhook_triggers` Postgres schema,
// fully siloed from the platform's `public` schema — see
// docs/package-migrations.md. `repoReviewLease` carries no foreign key
// to any Interchange core table: every workbench package already
// stores a platform id as a plain text column, never a cross-schema
// FK (see e.g. packages/chat/src/schema.ts's own header), and "repo"
// is a GitHub identity Interchange has no row for at all.
//
// The signing secret is encrypted at rest via Interchange's
// `CredentialCipher` seam — see `./store.ts` for the encrypt/decrypt
// wiring and `./signature.ts` for the security-model note on what that
// does and does not close.
import {
  boolean,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const webhookTriggersSchema = pgSchema("webhook_triggers");

export const webhookTrigger = webhookTriggersSchema.table("webhook_trigger", {
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
   * header, stored as a `CredentialCipher`-encrypted blob (see
   * `./store.ts`) — never returned by any route after creation except
   * a rotate response, and never in this encrypted form even then.
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

/**
 * A short-lived lease serializing `startReviewingRepos`' per-repo
 * mint-grant-and-create-trigger work (CL-7242): two concurrent calls
 * for the same `(tenantId, repo)` can both read "not set up yet"
 * before either write lands, so the lease is acquired first and is
 * the sole thing preventing both from proceeding. Never a record of
 * *completion* — only ever "someone claimed responsibility for this
 * repo's setup as of `leasedAt`" — so it can never assert something
 * untrue the way a stale "done" marker could (CL-7213). See
 * `./repo-review-lease.ts` for the acquire/release/steal-if-stale
 * semantics this table backs.
 */
export const repoReviewLease = webhookTriggersSchema.table(
  "repo_review_lease",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    repo: text("repo").notNull(),
    leasedAt: timestamp("leased_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("repo_review_lease_tenant_repo_unique").on(t.tenantId, t.repo),
  ],
);

export type RepoReviewLeaseRow = typeof repoReviewLease.$inferSelect;
