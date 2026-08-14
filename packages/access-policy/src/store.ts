// Postgres-backed persistence for this package's two tables, plus an
// in-memory fake with the same shape for tests that don't need a real
// database. `generateId` here is a package-local id minter, not
// `@intx/hub-common`'s — that module's `generateId` only mints the
// platform's own closed set of entity kinds (tenant, principal, role,
// ...), and a pending-invite id is a product-owned id this package is
// free to shape itself.
import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  resolveAccessPolicy,
  domainOf,
  serializeAllowedDomains,
} from "./policy";
import { pendingInvite, policy } from "./schema";
import {
  DEFAULT_ACCESS_POLICY,
  type AccessPolicy,
  type CreatePendingInvite,
  type PendingInvite,
  type UpdateAccessPolicy,
} from "./types";

function generatePendingInviteId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `pinv_${hex}`;
}

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
  createPendingInvite(
    tenantId: string,
    input: CreatePendingInvite,
  ): Promise<PendingInvite>;
  listPendingInvites(tenantId: string): Promise<readonly PendingInvite[]>;
  deletePendingInvite(tenantId: string, id: string): Promise<void>;
  /** Exact-email match first (case-insensitive, unconsumed), then a
   * domain-wildcard row for the email's domain. Domain rows are a
   * standing rule and are never marked consumed by a match; only an
   * exact-email row is single-use. */
  findMatchingPendingInvite(email: string): Promise<PendingInvite | undefined>;
  /** Atomically marks an unconsumed row consumed — `UPDATE ... WHERE id
   * = $1 AND consumed_at IS NULL RETURNING id` for the Postgres store,
   * a single synchronous check-and-set for the in-memory one, so two
   * concurrent redemptions of the same invite can never both win.
   * Returns `true` for whichever caller's update actually flipped the
   * row (this call won the race); `false` means the row was already
   * consumed — by a concurrent caller or an earlier call — and the
   * caller must treat that exactly like "no invite" rather than
   * proceeding to redeem it again. */
  consumePendingInvite(id: string): Promise<boolean>;
}

type PendingInviteDbRow = typeof pendingInvite.$inferSelect;

function toPendingInvite(row: PendingInviteDbRow): PendingInvite {
  const result: {
    id: string;
    tenantId: string;
    matchType: "email" | "domain";
    value: string;
    roleId?: string;
    invitedBy?: string;
    createdAt: Date;
    consumedAt?: Date;
  } = {
    id: row.id,
    tenantId: row.tenantId,
    matchType: row.matchType as "email" | "domain",
    value: row.value,
    createdAt: row.createdAt,
  };
  if (row.roleId !== null) result.roleId = row.roleId;
  if (row.invitedBy !== null) result.invitedBy = row.invitedBy;
  if (row.consumedAt !== null) result.consumedAt = row.consumedAt;
  return result;
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

    async upsertPolicy(tenantId, patch) {
      const current = await db
        .select()
        .from(policy)
        .where(eq(policy.tenantId, tenantId));
      const existing =
        current[0] === undefined
          ? DEFAULT_ACCESS_POLICY
          : resolveAccessPolicy(current[0]);
      const next: AccessPolicy = {
        selfSignup: patch.selfSignup ?? existing.selfSignup,
        allowedDomains: patch.allowedDomains ?? existing.allowedDomains,
        tenancyCreation: patch.tenancyCreation ?? existing.tenancyCreation,
      };
      const now = new Date();
      await db
        .insert(policy)
        .values({
          tenantId,
          selfSignup: next.selfSignup,
          allowedDomains: serializeAllowedDomains(next.allowedDomains),
          tenancyCreation: next.tenancyCreation,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: policy.tenantId,
          set: {
            selfSignup: next.selfSignup,
            allowedDomains: serializeAllowedDomains(next.allowedDomains),
            tenancyCreation: next.tenancyCreation,
            updatedAt: now,
          },
        });
      return next;
    },

    async createPendingInvite(tenantId, input) {
      const value =
        input.matchType === "email"
          ? input.value.trim().toLowerCase()
          : input.value.trim().toLowerCase().replace(/^@/, "");
      const row: {
        id: string;
        tenantId: string;
        matchType: "email" | "domain";
        value: string;
        roleId?: string;
        invitedBy?: string;
      } = {
        id: generatePendingInviteId(),
        tenantId,
        matchType: input.matchType,
        value,
      };
      if (input.roleId !== undefined) row.roleId = input.roleId;
      if (input.invitedBy !== undefined) row.invitedBy = input.invitedBy;
      const [inserted] = await db.insert(pendingInvite).values(row).returning();
      if (inserted === undefined) {
        throw new Error("pending invite insert returned no row");
      }
      return toPendingInvite(inserted);
    },

    async listPendingInvites(tenantId) {
      const rows = await db
        .select()
        .from(pendingInvite)
        .where(eq(pendingInvite.tenantId, tenantId));
      return rows.map(toPendingInvite);
    },

    async deletePendingInvite(tenantId, id) {
      await db
        .delete(pendingInvite)
        .where(
          and(eq(pendingInvite.id, id), eq(pendingInvite.tenantId, tenantId)),
        );
    },

    async findMatchingPendingInvite(email) {
      const normalized = email.trim().toLowerCase();
      const domain = domainOf(normalized);

      const [exact] = await db
        .select()
        .from(pendingInvite)
        .where(
          and(
            eq(pendingInvite.matchType, "email"),
            eq(pendingInvite.value, normalized),
            isNull(pendingInvite.consumedAt),
          ),
        );
      if (exact !== undefined) return toPendingInvite(exact);

      if (domain === undefined) return undefined;
      const [byDomain] = await db
        .select()
        .from(pendingInvite)
        .where(
          and(
            eq(pendingInvite.matchType, "domain"),
            eq(pendingInvite.value, domain),
          ),
        );
      return byDomain === undefined ? undefined : toPendingInvite(byDomain);
    },

    async consumePendingInvite(id) {
      // A single statement: Postgres row-locking during the UPDATE
      // serializes concurrent attempts on the same row, so exactly one
      // concurrent call sees `consumed_at IS NULL` still true and gets
      // a row back; every other one — whether racing in true parallel
      // or arriving after — matches zero rows and gets `false`.
      const [updated] = await db
        .update(pendingInvite)
        .set({ consumedAt: new Date() })
        .where(and(eq(pendingInvite.id, id), isNull(pendingInvite.consumedAt)))
        .returning({ id: pendingInvite.id });
      return updated !== undefined;
    },
  };
}

/** The fake this package's own route/gate tests drive through — no
 * Postgres required, same matching semantics as the real store. */
export function createInMemoryAccessPolicyStore(): AccessPolicyStore {
  const policies = new Map<string, AccessPolicy>();
  const invites = new Map<string, PendingInvite>();

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

    async createPendingInvite(tenantId, input) {
      const value =
        input.matchType === "email"
          ? input.value.trim().toLowerCase()
          : input.value.trim().toLowerCase().replace(/^@/, "");
      const invite: PendingInvite = {
        id: generatePendingInviteId(),
        tenantId,
        matchType: input.matchType,
        value,
        createdAt: new Date(),
        ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
        ...(input.invitedBy !== undefined
          ? { invitedBy: input.invitedBy }
          : {}),
      };
      invites.set(invite.id, invite);
      return invite;
    },

    async listPendingInvites(tenantId) {
      return Array.from(invites.values()).filter(
        (i) => i.tenantId === tenantId,
      );
    },

    async deletePendingInvite(tenantId, id) {
      const invite = invites.get(id);
      if (invite !== undefined && invite.tenantId === tenantId) {
        invites.delete(id);
      }
    },

    async findMatchingPendingInvite(email) {
      const normalized = email.trim().toLowerCase();
      const domain = domainOf(normalized);

      const exact = Array.from(invites.values()).find(
        (i) =>
          i.matchType === "email" &&
          i.value === normalized &&
          i.consumedAt === undefined,
      );
      if (exact !== undefined) return exact;

      if (domain === undefined) return undefined;
      return Array.from(invites.values()).find(
        (i) => i.matchType === "domain" && i.value === domain,
      );
    },

    async consumePendingInvite(id) {
      // No `await` between the read and the write below: this function
      // runs to completion synchronously once started, so two calls
      // made "concurrently" (e.g. via Promise.all) never interleave —
      // the same atomicity the real store gets from a single UPDATE
      // statement and Postgres row locking.
      const invite = invites.get(id);
      if (invite === undefined || invite.consumedAt !== undefined) {
        return false;
      }
      invites.set(id, { ...invite, consumedAt: new Date() });
      return true;
    },
  };
}
