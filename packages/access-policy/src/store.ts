// Postgres-backed persistence for this package's policy table, plus an
// in-memory fake with the same shape for tests that don't need a real
// database.
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { resolveAccessPolicy, serializeAllowedDomains } from "./policy";
import { policy } from "./schema";
import {
  DEFAULT_ACCESS_POLICY,
  type AccessPolicy,
  type UpdateAccessPolicy,
} from "./types";

export interface AccessPolicyStore {
  getPolicy(tenantId: string): Promise<AccessPolicy>;
  /** Whether an explicit policy row exists for this tenant — distinct
   * from `getPolicy`, which always returns an effective policy
   * (closed defaults when no row exists). The signup gate needs this
   * distinction to know whether the env-flag bootstrap still applies
   * or whether an explicit row has taken over. */
  hasPolicyRow(tenantId: string): Promise<boolean>;
  upsertPolicy(
    tenantId: string,
    patch: UpdateAccessPolicy,
  ): Promise<AccessPolicy>;
}

export function createDrizzleAccessPolicyStore<
  TSchema extends Record<string, unknown>,
>(db: PostgresJsDatabase<TSchema>): AccessPolicyStore {
  return {
    async getPolicy(tenantId) {
      const [row] = await db
        .select()
        .from(policy)
        .where(eq(policy.tenantId, tenantId));
      return resolveAccessPolicy(row);
    },

    async hasPolicyRow(tenantId) {
      const [row] = await db
        .select({ tenantId: policy.tenantId })
        .from(policy)
        .where(eq(policy.tenantId, tenantId));
      return row !== undefined;
    },

    // Read-modify-write under a transaction with a row lock rather than
    // an optimistic version-stamp check: two transactions starting in
    // the same wall-clock tick could still both pass a version check,
    // which is exactly the lost-update bug this closes.
    //
    // Because this method's row may not exist yet (it is an upsert),
    // `SELECT ... FOR UPDATE` alone has nothing to lock for a brand-new
    // tenant. The `INSERT ... ON CONFLICT DO NOTHING` below guarantees
    // a row first: two concurrent first-writes for the same tenant
    // serialize on that insert's unique-index conflict — the loser
    // blocks until the winner's transaction commits, then no-ops and
    // its own subsequent `SELECT ... FOR UPDATE` sees the winner's
    // committed row rather than racing it.
    async upsertPolicy(tenantId, patch) {
      return db.transaction(async (tx) => {
        const now = new Date();
        await tx
          .insert(policy)
          .values({
            tenantId,
            selfSignup: DEFAULT_ACCESS_POLICY.selfSignup,
            allowedDomains: serializeAllowedDomains(
              DEFAULT_ACCESS_POLICY.allowedDomains,
            ),
            tenancyCreation: DEFAULT_ACCESS_POLICY.tenancyCreation,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: policy.tenantId });

        const [current] = await tx
          .select()
          .from(policy)
          .where(eq(policy.tenantId, tenantId))
          .for("update");
        if (current === undefined) {
          throw new Error(
            `upsertPolicy: no access_policy.policy row for tenant ${tenantId} after ensuring one exists`,
          );
        }
        const existing = resolveAccessPolicy(current);
        const next: AccessPolicy = {
          selfSignup: patch.selfSignup ?? existing.selfSignup,
          allowedDomains: patch.allowedDomains ?? existing.allowedDomains,
          tenancyCreation: patch.tenancyCreation ?? existing.tenancyCreation,
        };
        await tx
          .update(policy)
          .set({
            selfSignup: next.selfSignup,
            allowedDomains: serializeAllowedDomains(next.allowedDomains),
            tenancyCreation: next.tenancyCreation,
            updatedAt: new Date(),
          })
          .where(eq(policy.tenantId, tenantId));
        return next;
      });
    },
  };
}

/** The fake this package's own route/gate tests drive through — no
 * Postgres required, same matching semantics as the real store. */
export function createInMemoryAccessPolicyStore(): AccessPolicyStore {
  const policies = new Map<string, AccessPolicy>();

  return {
    async getPolicy(tenantId) {
      return policies.get(tenantId) ?? DEFAULT_ACCESS_POLICY;
    },

    async hasPolicyRow(tenantId) {
      return policies.has(tenantId);
    },

    async upsertPolicy(tenantId, patch) {
      const existing = policies.get(tenantId) ?? DEFAULT_ACCESS_POLICY;
      const next: AccessPolicy = {
        selfSignup: patch.selfSignup ?? existing.selfSignup,
        allowedDomains: patch.allowedDomains ?? existing.allowedDomains,
        tenancyCreation: patch.tenancyCreation ?? existing.tenancyCreation,
      };
      policies.set(tenantId, next);
      return next;
    },
  };
}
