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
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateId } from "@intx/hub-common";
import { grant, principal, principalRole, role, tenant } from "@intx/db/schema";
import { channelTenancy } from "./schema";

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
}

/**
 * The production `ChannelTenancyStore`, operating on `@intx/db`'s
 * native `tenant`/`principal`/`role`/`principalRole`/`grant` tables
 * plus this package's own `channel_tenancy` link table.
 */
export function createDrizzleChannelTenancyStore<
  TSchema extends Record<string, unknown>,
>(db: ChannelTenancyDb<TSchema>): ChannelTenancyStore {
  return {
    async createChannelTenant(input) {
      const tenantId = generateId("tenant");
      const slug = slugForChannelTenant(input.name);
      const domain = `${slug}.localhost`;
      const now = new Date();

      await db.insert(tenant).values({
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
        await db.insert(role).values({
          id: roleId,
          tenantId,
          name: roleName,
          description: `System ${roleName} role`,
          isSystem: true,
          createdAt: now,
          updatedAt: now,
        });
      }

      const ownerPrincipalId = generateId("principal");
      await db.insert(principal).values({
        id: ownerPrincipalId,
        tenantId,
        kind: "user",
        refId: input.creatorUserId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(principalRole).values({
        principalId: ownerPrincipalId,
        roleId: roleIds.owner,
        createdAt: now,
      });

      await db.insert(grant).values({
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
      await db.insert(grant).values([
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
      await db.insert(grant).values({
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

      await db.insert(channelTenancy).values({
        channelId: input.channelId,
        tenantId,
        parentTenantId: input.parentTenantId,
        slug,
        createdAt: now,
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
      return row as ChannelTenancyRow | undefined;
    },

    async listChildChannelTenancies(parentTenantId) {
      const rows = await db
        .select()
        .from(channelTenancy)
        .where(eq(channelTenancy.parentTenantId, parentTenantId));
      return rows as ChannelTenancyRow[];
    },

    async moveChannelTenancy(input) {
      const [linkRow] = await db
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
      await db
        .update(tenant)
        .set({ parentId: input.newParentTenantId, updatedAt: new Date() })
        .where(eq(tenant.id, linkRow.tenantId));
      return linkRow as ChannelTenancyRow;
    },
  };
}

/**
 * An in-memory `ChannelTenancyStore`, for tests and any host wiring
 * chat routes without a database. Mints synthetic tenant/principal ids
 * with the same `generateId` shape as the drizzle store, but performs
 * no native-schema writes — the two stores share only their public
 * contract, exercised by `test/channel-tenancy.test.ts`.
 */
export function createInMemoryChannelTenancyStore(): ChannelTenancyStore {
  const byChannelId = new Map<string, ChannelTenancyRow>();

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
