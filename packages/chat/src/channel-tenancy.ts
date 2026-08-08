// Channels as child tenants: minting the native tenant a channel is
// anchored under, the chat-owned link table that records the
// parent↔child relationship (see `./schema.ts`'s `channelTenancy`),
// and the listing/move seams workbench owns because no native
// child-tenant listing or re-parenting route exists upstream (see
// `docs/channel-tenancy.md`).
//
// Tenant/principal/role/grant creation here mirrors
// `vendor/intx/hub-api/src/routes/tenants.ts`'s `POST /api/tenants`
// exactly — same system roles, same owner grant shape — so a channel
// tenant is indistinguishable, from the native surface's point of
// view, from one minted through that route by hand. This is
// consumption of `@intx/db`'s published schema, not a fork of the
// vendored route: nothing in `vendor/intx` is read or written by this
// module.
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateId } from "@intx/hub-common";
import { grant, principal, principalRole, role, tenant } from "@intx/db/schema";
import { authorize } from "@intx/authz";
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import { channelTenancy } from "./schema";

const log = getLogger(["chat", "channel-tenancy"]);

/**
 * The resource/action a caller must hold a `manage`-level grant for,
 * in the destination tenant, before a channel can be moved there.
 * Mirrors the shape the mint's own owner/admin grants are seeded
 * with (see `createChannelTenant` below): `resource: "*"` scoped by
 * `action`, so any role carrying platform-wide manage authority in
 * the destination tenant satisfies it.
 */
const MOVE_DESTINATION_RESOURCE = "workflow-run:*";
const MOVE_DESTINATION_ACTION = "manage";

const SYSTEM_ROLES = ["owner", "admin", "member"] as const;

/**
 * Derives a URL-safe slug from a channel's name, plus a random tail
 * for uniqueness. `tenant.slug` is unique across the whole platform,
 * so a channel tenant can never collide with another channel's, or
 * with a bench created through the native route — the tail is a
 * collision-avoidance measure, not a display detail, and is never
 * shown to a user.
 */
function slugForChannelTenant(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const tail = generateId("tenant").slice(-8);
  return `${base !== "" ? base : "channel"}-${tail}`;
}

export type ChannelTenancyDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export interface ChannelTenancyRow {
  readonly channelId: string;
  readonly tenantId: string;
  readonly parentTenantId: string;
  readonly slug: string;
  readonly createdAt: Date;
}

export interface CreateChannelTenantInput {
  readonly parentTenantId: string;
  readonly channelId: string;
  readonly name: string;
  /**
   * The auth user id (a principal's `refId`, never a principal's own
   * `id`) the child tenant's owner principal is minted for — the same
   * identity the creator already holds in the parent bench, given a
   * fresh principal and the child tenant's `owner` role, exactly as
   * `POST /api/tenants` seeds its creator.
   */
  readonly creatorUserId: string;
}

export interface CreateChannelTenantResult {
  readonly tenantId: string;
  readonly parentTenantId: string;
  readonly domain: string;
  readonly slug: string;
  readonly ownerPrincipalId: string;
}

export interface MoveChannelTenancyInput {
  readonly channelId: string;
  readonly newParentTenantId: string;
}

export interface AuthorizeMoveDestinationInput {
  readonly newParentTenantId: string;
  /** The caller's auth user id (`principal.refId`) — moving tenants
   * looks up whatever principal that identity holds in the
   * destination tenant, not the principal id the caller authenticated
   * with in its own tenant, since those are different rows. */
  readonly callerRefId: string;
}

/**
 * The result of checking whether a move to `newParentTenantId` is
 * allowed: the destination must exist, and the caller must hold an
 * active principal there carrying a manage-level grant. Both are
 * reported so a route can fail closed with the right status —
 * 404 when the destination itself is bogus, 403 when it is real but
 * the caller has no standing in it.
 */
export interface DestinationTenantAuthorization {
  readonly tenantExists: boolean;
  readonly callerHasManageGrant: boolean;
}

export interface ChannelTenancyStore {
  /**
   * Mints a native tenant as `input.channelId`'s own tenancy, parented
   * under `input.parentTenantId`, seeds it exactly as the native
   * tenant-creation route does (system roles, owner grant, admin/member
   * grants, and an owner principal for `input.creatorUserId`), and
   * records the link in `channel_tenancy`.
   */
  createChannelTenant(
    input: CreateChannelTenantInput,
  ): Promise<CreateChannelTenantResult>;

  /** The channel tenancy link row for one channel, or `undefined` for
   * a channel that predates this rollout (a legacy flat channel — see
   * `docs/channel-tenancy.md`) or was never anchored as a tenant. */
  getChannelTenancy(channelId: string): Promise<ChannelTenancyRow | undefined>;

  /** Every channel tenancy link parented under `parentTenantId` — the
   * workbench-owned answer to "list this bench's child tenants",
   * which no native route provides. */
  listChildChannelTenancies(
    parentTenantId: string,
  ): Promise<ChannelTenancyRow[]>;

  /**
   * Re-parents a channel's tenancy: updates both the chat-owned link
   * row (what workbench's own listing reads) and the native
   * `tenant.parentId` column directly, through `@intx/db`'s published
   * schema — there is no native PATCH for a tenant's `parentId`, so
   * this is the only way to keep the two in sync. Throws for a channel
   * with no tenancy link (nothing to move).
   */
  moveChannelTenancy(
    input: MoveChannelTenancyInput,
  ): Promise<ChannelTenancyRow>;

  /**
   * Fails closed on a move destination: checks `newParentTenantId`
   * names a real tenant, then — only if it does — whether
   * `callerRefId` holds an active, manage-granted principal there.
   * Queries the same grant machinery `requireGrant` uses
   * (`@intx/authz`'s `authorize`), evaluated against the destination
   * tenant rather than the caller's own. Neither `moveChannelTenancy`
   * nor the route that calls it performs any authorization of its
   * own — this is the one place that decision is made.
   */
  authorizeMoveDestination(
    input: AuthorizeMoveDestinationInput,
  ): Promise<DestinationTenantAuthorization>;

  /**
   * Undoes a mint that a subsequent step (the channel host launch)
   * failed to complete: deletes the `channel_tenancy` link and the
   * tenant row itself, which cascades to every row seeded alongside
   * it (`role`, `principal`, `principal_role`, `grant`) through their
   * own `onDelete: "cascade"` foreign keys to `tenant.id`. Leaves
   * nothing behind for a channel that never finished launching,
   * rather than a fully-privileged tenant with no channel pointing at
   * it.
   */
  compensateChannelTenant(tenantId: string): Promise<void>;
}

export interface ChannelTenancyAuthzDeps {
  /** The same grant store `requireGrant` collects from, so a
   * destination-tenant check resolves against live grant rows rather
   * than a second, hand-rolled authorization path. */
  readonly grantStore: GrantStore;
  readonly conditionRegistry?: ConditionRegistry;
}

/**
 * The production `ChannelTenancyStore`, operating on `@intx/db`'s
 * native `tenant`/`principal`/`role`/`principalRole`/`grant` tables
 * plus this package's own `channel_tenancy` link table.
 */
export function createDrizzleChannelTenancyStore<
  TSchema extends Record<string, unknown>,
>(
  db: ChannelTenancyDb<TSchema>,
  authz: ChannelTenancyAuthzDeps,
): ChannelTenancyStore {
  return {
    async createChannelTenant(input) {
      const tenantId = generateId("tenant");
      const slug = slugForChannelTenant(input.name);
      const domain = `${slug}.localhost`;
      const now = new Date();
      const ownerPrincipalId = generateId("principal");

      // Every insert below seeds one tenant's worth of native state —
      // tenant, its three system roles, the creator's owner principal
      // and role assignment, every system grant, and the chat-owned
      // link row. A failure partway through must never leave a
      // half-seeded tenant behind, so the whole mint runs as one
      // transaction: it either lands complete or not at all.
      await db.transaction(async (tx) => {
        await tx.insert(tenant).values({
          id: tenantId,
          name: input.name,
          slug,
          domain,
          parentId: input.parentTenantId,
          createdAt: now,
          updatedAt: now,
        });

        const roleIds: Record<(typeof SYSTEM_ROLES)[number], string> = {
          owner: "",
          admin: "",
          member: "",
        };
        for (const roleName of SYSTEM_ROLES) {
          const roleId = generateId("role");
          roleIds[roleName] = roleId;
          await tx.insert(role).values({
            id: roleId,
            tenantId,
            name: roleName,
            description: `System ${roleName} role`,
            isSystem: true,
            createdAt: now,
            updatedAt: now,
          });
        }

        await tx.insert(principal).values({
          id: ownerPrincipalId,
          tenantId,
          kind: "user",
          refId: input.creatorUserId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(principalRole).values({
          principalId: ownerPrincipalId,
          roleId: roleIds.owner,
          createdAt: now,
        });

        await tx.insert(grant).values({
          id: generateId("grant"),
          tenantId,
          roleId: roleIds.owner,
          resource: "*",
          action: "*",
          effect: "allow",
          origin: "system",
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(grant).values([
          {
            id: generateId("grant"),
            tenantId,
            roleId: roleIds.admin,
            resource: "*",
            action: "read",
            effect: "allow" as const,
            origin: "system" as const,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: generateId("grant"),
            tenantId,
            roleId: roleIds.admin,
            resource: "*",
            action: "create",
            effect: "allow" as const,
            origin: "system" as const,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: generateId("grant"),
            tenantId,
            roleId: roleIds.admin,
            resource: "*",
            action: "manage",
            effect: "allow" as const,
            origin: "system" as const,
            createdAt: now,
            updatedAt: now,
          },
        ]);
        await tx.insert(grant).values({
          id: generateId("grant"),
          tenantId,
          roleId: roleIds.member,
          resource: "*",
          action: "read",
          effect: "allow",
          origin: "system",
          createdAt: now,
          updatedAt: now,
        });

        await tx.insert(channelTenancy).values({
          channelId: input.channelId,
          tenantId,
          parentTenantId: input.parentTenantId,
          slug,
          createdAt: now,
        });
      });

      return {
        tenantId,
        parentTenantId: input.parentTenantId,
        domain,
        slug,
        ownerPrincipalId,
      };
    },

    async getChannelTenancy(channelId) {
      const [row] = await db
        .select()
        .from(channelTenancy)
        .where(eq(channelTenancy.channelId, channelId))
        .limit(1);
      return row;
    },

    async listChildChannelTenancies(parentTenantId) {
      return db
        .select()
        .from(channelTenancy)
        .where(eq(channelTenancy.parentTenantId, parentTenantId));
    },

    async authorizeMoveDestination({ newParentTenantId, callerRefId }) {
      const [destinationTenant] = await db
        .select()
        .from(tenant)
        .where(eq(tenant.id, newParentTenantId))
        .limit(1);
      if (destinationTenant === undefined) {
        return { tenantExists: false, callerHasManageGrant: false };
      }

      const [destinationPrincipal] = await db
        .select()
        .from(principal)
        .where(
          and(
            eq(principal.tenantId, newParentTenantId),
            eq(principal.refId, callerRefId),
            eq(principal.status, "active"),
          ),
        )
        .limit(1);
      if (destinationPrincipal === undefined) {
        return { tenantExists: true, callerHasManageGrant: false };
      }

      const result = await authorize(
        authz.grantStore,
        destinationPrincipal.id,
        newParentTenantId,
        MOVE_DESTINATION_RESOURCE,
        MOVE_DESTINATION_ACTION,
        authz.conditionRegistry,
      );
      return {
        tenantExists: true,
        callerHasManageGrant: result.effect === "allow",
      };
    },

    async moveChannelTenancy(input) {
      return db.transaction(async (tx) => {
        const [linkRow] = await tx
          .update(channelTenancy)
          .set({ parentTenantId: input.newParentTenantId })
          .where(eq(channelTenancy.channelId, input.channelId))
          .returning();
        if (linkRow === undefined) {
          throw new Error(
            `No channel tenancy for channel "${input.channelId}"; a legacy ` +
              `channel predating this rollout has nothing to move`,
          );
        }
        await tx
          .update(tenant)
          .set({ parentId: input.newParentTenantId, updatedAt: new Date() })
          .where(eq(tenant.id, linkRow.tenantId));
        return linkRow;
      });
    },

    async compensateChannelTenant(tenantId) {
      log.error(
        "Compensating channel tenant {tenantId}: deleting the freshly " +
          "minted tenant and its seeded rows after a downstream failure",
        { tenantId },
      );
      await db.transaction(async (tx) => {
        await tx
          .delete(channelTenancy)
          .where(eq(channelTenancy.tenantId, tenantId));
        await tx.delete(tenant).where(eq(tenant.id, tenantId));
      });
    },
  };
}

/**
 * An in-memory `ChannelTenancyStore`, for tests and any host wiring
 * chat routes without a database. Mints synthetic tenant/principal ids
 * with the same `generateId` shape as the drizzle store, but performs
 * no native-schema writes — the two stores share only their public
 * contract, exercised by `test/channel-tenancy.test.ts`.
 *
 * The two extra methods below `ChannelTenancyStore` declares
 * (`registerExistingTenant`, `grantManageInTenant`) are test-support
 * only: they let a unit test stand up "a real tenant the caller has
 * no standing in" and "a real tenant the caller manages" without a
 * database, exercising `authorizeMoveDestination`'s two failure modes
 * plus its success path.
 */
export function createInMemoryChannelTenancyStore(): ChannelTenancyStore & {
  registerExistingTenant(tenantId: string): void;
  grantManageInTenant(refId: string, tenantId: string): void;
} {
  const byChannelId = new Map<string, ChannelTenancyRow>();
  const existingTenants = new Set<string>();
  const manageGrants = new Set<string>();

  const manageGrantKey = (refId: string, tenantId: string) =>
    `${refId}::${tenantId}`;

  return {
    async createChannelTenant(input) {
      if (byChannelId.has(input.channelId)) {
        throw new Error(`Channel "${input.channelId}" already has a tenancy`);
      }
      const tenantId = generateId("tenant");
      const slug = slugForChannelTenant(input.name);
      const row: ChannelTenancyRow = {
        channelId: input.channelId,
        tenantId,
        parentTenantId: input.parentTenantId,
        slug,
        createdAt: new Date(),
      };
      byChannelId.set(input.channelId, row);
      existingTenants.add(tenantId);
      // The creator is minted as this tenant's owner, exactly as the
      // drizzle store does — the owner role's `*`/`*` grant covers
      // the move-destination check too.
      manageGrants.add(manageGrantKey(input.creatorUserId, tenantId));
      return {
        tenantId,
        parentTenantId: input.parentTenantId,
        domain: `${slug}.localhost`,
        slug,
        ownerPrincipalId: generateId("principal"),
      };
    },

    async getChannelTenancy(channelId) {
      return byChannelId.get(channelId);
    },

    async listChildChannelTenancies(parentTenantId) {
      return [...byChannelId.values()].filter(
        (row) => row.parentTenantId === parentTenantId,
      );
    },

    async authorizeMoveDestination({ newParentTenantId, callerRefId }) {
      if (!existingTenants.has(newParentTenantId)) {
        return { tenantExists: false, callerHasManageGrant: false };
      }
      return {
        tenantExists: true,
        callerHasManageGrant: manageGrants.has(
          manageGrantKey(callerRefId, newParentTenantId),
        ),
      };
    },

    async compensateChannelTenant(tenantId) {
      existingTenants.delete(tenantId);
      for (const [channelId, row] of byChannelId) {
        if (row.tenantId === tenantId) byChannelId.delete(channelId);
      }
    },

    registerExistingTenant(tenantId) {
      existingTenants.add(tenantId);
    },

    grantManageInTenant(refId, tenantId) {
      manageGrants.add(manageGrantKey(refId, tenantId));
    },

    async moveChannelTenancy(input) {
      const existing = byChannelId.get(input.channelId);
      if (existing === undefined) {
        throw new Error(
          `No channel tenancy for channel "${input.channelId}"; a legacy ` +
            `channel predating this rollout has nothing to move`,
        );
      }
      const moved: ChannelTenancyRow = {
        ...existing,
        parentTenantId: input.newParentTenantId,
      };
      byChannelId.set(input.channelId, moved);
      return moved;
    },
  };
}
