// Bilateral trust between two tenants, consumed directly off `@intx/db`'s
// published `federationTrust`/`tenant` tables — ordinary consumption of a
// published schema, not a fork of `vendor/intx/hub-api/src/routes/tenant-federation.ts`
// (the native CRUD for one-directional trust rows). This module adds the
// one thing that route doesn't: the workbench-owned notion of "bilateral"
// — both tenants have separately opted in — which is what
// `packages/chat/src/channel-share.ts` gates channel projection on.
//
// Mirrors `channel-tenancy.ts`'s shape: a store interface, a drizzle
// implementation, and an in-memory test double with `registerTenant` test
// support.
import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateId } from "@intx/hub-common";
import { federationTrust, tenant } from "@intx/db/schema";

export type FederationTrustDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export interface FederationTrustStore {
  /** Upserts both directions of trust between the two tenants as
   * `direction: 'bilateral'` — idempotent, safe to call again on an
   * already-bilateral pair. */
  establishBilateralTrust(tenantA: string, tenantB: string): Promise<void>;

  /** True iff BOTH `(tenantA -> tenantB)` and `(tenantB -> tenantA)`
   * rows exist with `direction === 'bilateral'`. A single
   * one-directional row (native `'inbound'`/`'outbound'`, or a
   * bilateral row missing its mirror) is not enough. */
  hasBilateralTrust(tenantA: string, tenantB: string): Promise<boolean>;

  /** Deletes both directions of trust between the two tenants. */
  revokeBilateralTrust(tenantA: string, tenantB: string): Promise<void>;

  /** When both tenants share the same non-null `parentId`, the parent
   * tenant's id and name — the "shared via parent · <name>" context a
   * channel-list row can show. `undefined` for unrelated tenants or a
   * tenant with no parent. */
  resolveSharedViaParent(
    tenantA: string,
    tenantB: string,
  ): Promise<{ parentTenantId: string; parentName: string } | undefined>;

  /** A tenant's display name, or `undefined` if it doesn't exist. */
  getTenantName(tenantId: string): Promise<string | undefined>;
}

/**
 * The production `FederationTrustStore`, operating on `@intx/db`'s native
 * `federation_trust`/`tenant` tables.
 */
export function createDrizzleFederationTrustStore<
  TSchema extends Record<string, unknown>,
>(db: FederationTrustDb<TSchema>): FederationTrustStore {
  async function upsertDirection(
    fromTenantId: string,
    toTenantId: string,
  ): Promise<void> {
    const [existing] = await db
      .select({ id: federationTrust.id })
      .from(federationTrust)
      .where(
        and(
          eq(federationTrust.tenantId, fromTenantId),
          eq(federationTrust.targetTenantId, toTenantId),
        ),
      )
      .limit(1);
    if (existing !== undefined) {
      await db
        .update(federationTrust)
        .set({ direction: "bilateral" })
        .where(eq(federationTrust.id, existing.id));
      return;
    }
    await db.insert(federationTrust).values({
      id: generateId("federationTrust"),
      tenantId: fromTenantId,
      targetTenantId: toTenantId,
      direction: "bilateral",
    });
  }

  return {
    async establishBilateralTrust(tenantA, tenantB) {
      await upsertDirection(tenantA, tenantB);
      await upsertDirection(tenantB, tenantA);
    },

    async hasBilateralTrust(tenantA, tenantB) {
      const rows = await db
        .select({
          tenantId: federationTrust.tenantId,
          targetTenantId: federationTrust.targetTenantId,
          direction: federationTrust.direction,
        })
        .from(federationTrust)
        .where(
          and(
            inArray(federationTrust.tenantId, [tenantA, tenantB]),
            inArray(federationTrust.targetTenantId, [tenantA, tenantB]),
          ),
        );
      const forward = rows.some(
        (row) =>
          row.tenantId === tenantA &&
          row.targetTenantId === tenantB &&
          row.direction === "bilateral",
      );
      const backward = rows.some(
        (row) =>
          row.tenantId === tenantB &&
          row.targetTenantId === tenantA &&
          row.direction === "bilateral",
      );
      return forward && backward;
    },

    async revokeBilateralTrust(tenantA, tenantB) {
      await db
        .delete(federationTrust)
        .where(
          and(
            eq(federationTrust.tenantId, tenantA),
            eq(federationTrust.targetTenantId, tenantB),
          ),
        );
      await db
        .delete(federationTrust)
        .where(
          and(
            eq(federationTrust.tenantId, tenantB),
            eq(federationTrust.targetTenantId, tenantA),
          ),
        );
    },

    async resolveSharedViaParent(tenantA, tenantB) {
      const rows = await db
        .select({ id: tenant.id, parentId: tenant.parentId })
        .from(tenant)
        .where(inArray(tenant.id, [tenantA, tenantB]));
      const a = rows.find((row) => row.id === tenantA);
      const b = rows.find((row) => row.id === tenantB);
      if (
        a?.parentId === undefined ||
        a.parentId === null ||
        b?.parentId === undefined ||
        b.parentId === null ||
        a.parentId !== b.parentId
      ) {
        return undefined;
      }
      const [parent] = await db
        .select({ name: tenant.name })
        .from(tenant)
        .where(eq(tenant.id, a.parentId))
        .limit(1);
      if (parent === undefined) return undefined;
      return { parentTenantId: a.parentId, parentName: parent.name };
    },

    async getTenantName(tenantId) {
      const [row] = await db
        .select({ name: tenant.name })
        .from(tenant)
        .where(eq(tenant.id, tenantId))
        .limit(1);
      return row?.name;
    },
  };
}

/**
 * An in-memory `FederationTrustStore`, for tests and any host wiring chat
 * routes without a database. `registerTenant` is test-support only —
 * standing up a fake native `tenant` row (name + optional parent) without
 * a database, mirroring `createInMemoryChannelTenancyStore`'s
 * `registerExistingTenant`. `seedDirectionalTrust` lets a test construct
 * the "only one direction exists" case directly, without going through
 * `establishBilateralTrust` (which always writes both).
 */
export function createInMemoryFederationTrustStore(): FederationTrustStore & {
  registerTenant(id: string, name: string, parentId?: string): void;
  seedDirectionalTrust(
    fromTenantId: string,
    toTenantId: string,
    direction: "inbound" | "outbound" | "bilateral",
  ): void;
} {
  const tenants = new Map<string, { name: string; parentId?: string }>();
  const trustRows = new Map<string, "inbound" | "outbound" | "bilateral">();
  const key = (from: string, to: string) => `${from}::${to}`;

  return {
    registerTenant(id, name, parentId) {
      tenants.set(id, parentId !== undefined ? { name, parentId } : { name });
    },

    seedDirectionalTrust(fromTenantId, toTenantId, direction) {
      trustRows.set(key(fromTenantId, toTenantId), direction);
    },

    async establishBilateralTrust(tenantA, tenantB) {
      trustRows.set(key(tenantA, tenantB), "bilateral");
      trustRows.set(key(tenantB, tenantA), "bilateral");
    },

    async hasBilateralTrust(tenantA, tenantB) {
      return (
        trustRows.get(key(tenantA, tenantB)) === "bilateral" &&
        trustRows.get(key(tenantB, tenantA)) === "bilateral"
      );
    },

    async revokeBilateralTrust(tenantA, tenantB) {
      trustRows.delete(key(tenantA, tenantB));
      trustRows.delete(key(tenantB, tenantA));
    },

    async resolveSharedViaParent(tenantA, tenantB) {
      const a = tenants.get(tenantA);
      const b = tenants.get(tenantB);
      if (
        a?.parentId === undefined ||
        b?.parentId === undefined ||
        a.parentId !== b.parentId
      ) {
        return undefined;
      }
      const parent = tenants.get(a.parentId);
      if (parent === undefined) return undefined;
      return { parentTenantId: a.parentId, parentName: parent.name };
    },

    async getTenantName(tenantId) {
      return tenants.get(tenantId)?.name;
    },
  };
}
