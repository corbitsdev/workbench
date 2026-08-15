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
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateId } from "@intx/hub-common";
import { grant, principal, principalRole, role, tenant } from "@intx/db/schema";
import { parseGrantRow } from "@intx/db";
import { evaluateGrants } from "@intx/authz";
import type { ConditionRegistry, GrantRule } from "@intx/authz";
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
 * A defensive ceiling on how many ancestors `tenantIsDescendantOf`
 * will walk before giving up. The tenant hierarchy this rollout can
 * observe is shallow (a bench and its channels), so a real chain this
 * long can only mean a cycle already exists somewhere in the tree that
 * predates this guard — surfacing that loudly (see the thrown error
 * below) beats spinning forever on data this code did not create.
 */
const MAX_ANCESTOR_WALK = 1000;

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
  /** The caller's auth user id (`principal.refId`) — moving tenants
   * looks up whatever principal that identity holds in the
   * destination tenant, not the principal id the caller authenticated
   * with in its own tenant, since those are different rows. Checked
   * inside the same transaction that performs the move (see
   * `moveChannelTenancy` below), never as a separate round trip, so a
   * grant revocation or destination-tenant deletion cannot land in a
   * window between the check and the act. */
  readonly callerRefId: string;
}

/**
 * The outcome of a move attempt. `"destination_not_found"` and
 * `"forbidden"` are the two ways the destination fails closed — the
 * first when `newParentTenantId` names no real tenant, the second when
 * it is real but the caller holds no manage-granted principal there.
 * `"cycle"` is a third, distinct failure mode: the destination is the
 * channel's own tenant, or a descendant of it, so completing the move
 * would make the channel its own ancestor. This is a structural
 * rejection, not an authorization one — a caller can hold every grant
 * in the world and it is still refused, so it is reported separately
 * rather than folded into `"forbidden"`, which would misstate why the
 * move was refused. `"no_tenancy"` is the pre-existing "legacy
 * channel" case: nothing to move. All four, and the successful
 * `"moved"` case, are reported by the same call so a route never has
 * to reconcile results from two separate reads of a fact that can
 * change between them.
 */
export type MoveChannelTenancyOutcome =
  | { readonly kind: "moved"; readonly row: ChannelTenancyRow }
  | { readonly kind: "destination_not_found" }
  | { readonly kind: "cycle" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "no_tenancy" };

/** The subset of a native `principal` row a person-DM's counterpart
 * check needs — never the full row, since nothing else here has a
 * reason to touch identity fields (`refId`, timestamps). */
export interface TenantPrincipal {
  readonly id: string;
  readonly kind: "user" | "agent" | "workflow";
  readonly status: "active" | "suspended" | "invited" | "deactivated";
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
   * Which of `tenantIds` is itself a channel's own tenant — the
   * workbench-owned answer to "is this a workbench or a channel child
   * tenancy", since native tenant rows carry no such marker. Callers
   * (the bench switcher's memberships filter, chiefly) hold a list of
   * tenant ids from `/api/me/principals` and need to know which ones
   * to exclude, regardless of which parent each channel belongs to.
   */
  listChannelTenantIds(
    tenantIds: readonly string[],
  ): Promise<ReadonlySet<string>>;

  /**
   * Re-parents a channel's tenancy, but only after re-verifying —
   * inside the very transaction that performs the move, under row
   * locks — that `newParentTenantId` names a real tenant and that
   * `callerRefId` holds an active, manage-granted principal there.
   * The check and the act are not two round trips: a caller cannot
   * pass authorization and then race a grant revocation or a
   * destination-tenant deletion into the gap, because there is no gap
   * — the destination tenant row, the caller's principal row, and
   * every grant row that could resolve the decision are locked
   * (`SELECT ... FOR UPDATE`) for the lifetime of the same transaction
   * that writes both the chat-owned link row (what workbench's own
   * listing reads) and the native `tenant.parentId` column — there is
   * no native PATCH for a tenant's `parentId`, so this is the only way
   * to keep the two in sync. Also rejects (`{ kind: "cycle" }`) a
   * destination that is the channel's own tenant or a descendant of
   * it, walking the destination's ancestor chain under the same locks
   * so the check can never observe a hierarchy that has since changed
   * out from under it. Returns `{ kind: "no_tenancy" }` for a channel
   * with no tenancy link (nothing to move), checked before the
   * destination is even considered.
   */
  moveChannelTenancy(
    input: MoveChannelTenancyInput,
  ): Promise<MoveChannelTenancyOutcome>;

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

  /**
   * The native `principal` row for `principalId` within `tenantId`,
   * or `undefined` when no such principal exists there — the
   * validation a person-DM chat's `POST /channels` runs before
   * minting the second participant, so a stale or cross-tenant
   * `principalId` fails closed with an ordinary 400 rather than
   * silently seeding a participant record nothing backs. Reads the
   * native `principal` table directly, the same table this store's
   * own mint seeds an owner row into (see `createChannelTenant`) —
   * not a channel-tenancy concept on its own, but colocated here
   * since this is the one store in the package already holding a
   * `db` handle onto native tenancy tables.
   */
  getTenantPrincipal(
    tenantId: string,
    principalId: string,
  ): Promise<TenantPrincipal | undefined>;
}

export interface ChannelTenancyAuthzDeps {
  /**
   * Passed straight through to `evaluateGrants` for the destination
   * check `moveChannelTenancy` runs inside its own transaction — no
   * `GrantStore` here, deliberately: a `GrantStore` (as `requireGrant`
   * uses) always reads outside any caller-supplied transaction, which
   * is exactly the two-round-trip shape that let authorization and the
   * write it gated drift apart. The destination check instead collects
   * and locks its own grant rows directly against the move's own `tx`
   * (see `moveChannelTenancy`).
   */
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

    async listChannelTenantIds(tenantIds) {
      if (tenantIds.length === 0) return new Set();
      const rows = await db
        .select({ tenantId: channelTenancy.tenantId })
        .from(channelTenancy)
        .where(inArray(channelTenancy.tenantId, tenantIds));
      return new Set(rows.map((row) => row.tenantId));
    },

    async moveChannelTenancy({ channelId, newParentTenantId, callerRefId }) {
      return db.transaction(async (tx) => {
        // Locks the link row for the lifetime of this transaction —
        // a second, concurrent move of the same channel blocks here
        // rather than racing this one to a write.
        const [linkRow] = await tx
          .select()
          .from(channelTenancy)
          .where(eq(channelTenancy.channelId, channelId))
          .for("update")
          .limit(1);
        if (linkRow === undefined) {
          return { kind: "no_tenancy" as const };
        }

        // Everything below re-verifies the destination from inside
        // this same transaction, under row locks, rather than trusting
        // a decision made by an earlier, independent round trip: a
        // grant revocation or a destination-tenant deletion committed
        // by another transaction blocks on these locks until this one
        // finishes, instead of landing in a gap between "checked" and
        // "acted on".
        const [destinationTenant] = await tx
          .select()
          .from(tenant)
          .where(eq(tenant.id, newParentTenantId))
          .for("update")
          .limit(1);
        if (destinationTenant === undefined) {
          return { kind: "destination_not_found" as const };
        }

        // Reject a move that would make the channel its own ancestor:
        // the destination is the channel's own tenant (a self-parent),
        // or the destination descends from it (a longer cycle). Walked
        // under the same row locks as everything else here, so a
        // concurrent re-parenting of an ancestor tenant cannot slip a
        // cycle past this check between the read and the write.
        let cursor: { id: string; parentId: string | null } = {
          id: destinationTenant.id,
          parentId: destinationTenant.parentId,
        };
        const visited = new Set<string>();
        for (let depth = 0; ; depth += 1) {
          if (cursor.id === linkRow.tenantId) {
            return { kind: "cycle" as const };
          }
          if (cursor.parentId === null) break;
          if (visited.has(cursor.id) || depth >= MAX_ANCESTOR_WALK) {
            throw new Error(
              `Tenant hierarchy cycle detected walking ancestors of ` +
                `"${destinationTenant.id}", unrelated to this move`,
            );
          }
          visited.add(cursor.id);
          const [ancestor] = await tx
            .select({ id: tenant.id, parentId: tenant.parentId })
            .from(tenant)
            .where(eq(tenant.id, cursor.parentId))
            .for("update")
            .limit(1);
          if (ancestor === undefined) break;
          cursor = ancestor;
        }

        const [destinationPrincipal] = await tx
          .select()
          .from(principal)
          .where(
            and(
              eq(principal.tenantId, newParentTenantId),
              eq(principal.refId, callerRefId),
              eq(principal.status, "active"),
            ),
          )
          .for("update")
          .limit(1);
        if (destinationPrincipal === undefined) {
          return { kind: "forbidden" as const };
        }

        const roleAssignments = await tx
          .select()
          .from(principalRole)
          .where(eq(principalRole.principalId, destinationPrincipal.id))
          .for("update");
        const roleIds = roleAssignments.map((assignment) => assignment.roleId);

        const now = new Date();
        const ownership = [eq(grant.principalId, destinationPrincipal.id)];
        if (roleIds.length > 0) {
          ownership.push(inArray(grant.roleId, roleIds));
        }
        const grantRows = await tx
          .select()
          .from(grant)
          .where(
            and(
              eq(grant.tenantId, newParentTenantId),
              or(...ownership),
              or(isNull(grant.expiresAt), gt(grant.expiresAt, now)),
            ),
          )
          .for("update");
        const grantRules: GrantRule[] = grantRows.map((row) =>
          parseGrantRow(row),
        );

        const evalOptionsBase = {
          principalId: destinationPrincipal.id,
          tenantId: newParentTenantId,
        };
        const decision = await evaluateGrants(
          grantRules,
          MOVE_DESTINATION_RESOURCE,
          MOVE_DESTINATION_ACTION,
          authz.conditionRegistry
            ? { ...evalOptionsBase, registry: authz.conditionRegistry }
            : evalOptionsBase,
        );
        if (decision.effect !== "allow") {
          return { kind: "forbidden" as const };
        }

        const [movedLink] = await tx
          .update(channelTenancy)
          .set({ parentTenantId: newParentTenantId })
          .where(eq(channelTenancy.channelId, channelId))
          .returning();
        if (movedLink === undefined) {
          throw new Error(
            `Channel tenancy for "${channelId}" vanished mid-transaction`,
          );
        }
        await tx
          .update(tenant)
          .set({ parentId: newParentTenantId, updatedAt: now })
          .where(eq(tenant.id, movedLink.tenantId));

        return { kind: "moved" as const, row: movedLink };
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

    async getTenantPrincipal(tenantId, principalId) {
      const [row] = await db
        .select({
          id: principal.id,
          kind: principal.kind,
          status: principal.status,
        })
        .from(principal)
        .where(
          and(eq(principal.tenantId, tenantId), eq(principal.id, principalId)),
        )
        .limit(1);
      return row as TenantPrincipal | undefined;
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
 * The three extra methods below `ChannelTenancyStore` declares
 * (`registerExistingTenant`, `grantManageInTenant`, `registerPrincipal`)
 * are test-support only: `registerExistingTenant` takes an optional
 * parent so a unit test can build an arbitrary tenant hierarchy without
 * a database. Together they let a test stand up "a real tenant the
 * caller has no standing in", "a real tenant the caller manages", and a
 * cyclic hierarchy, exercising `moveChannelTenancy`'s destination-check
 * outcomes (`"destination_not_found"`, `"cycle"`, `"forbidden"`,
 * `"moved"`). `registerPrincipal` does the same for `getTenantPrincipal`
 * — standing up a fake native `principal` row without a database.
 */
export function createInMemoryChannelTenancyStore(): ChannelTenancyStore & {
  registerExistingTenant(tenantId: string, parentTenantId?: string): void;
  grantManageInTenant(refId: string, tenantId: string): void;
  registerPrincipal(tenantId: string, principal: TenantPrincipal): void;
} {
  const byChannelId = new Map<string, ChannelTenancyRow>();
  const existingTenants = new Set<string>();
  const manageGrants = new Set<string>();
  const principalsByKey = new Map<string, TenantPrincipal>();
  const principalKey = (tenantId: string, principalId: string) =>
    `${tenantId}::${principalId}`;
  // Mirrors the drizzle store's `tenant.parentId`: every tenant this
  // store knows of maps to its parent, or `undefined` for a root. Kept
  // separately from `byChannelId` because a destination tenant in a
  // cycle test is often not itself a channel's tenancy — plain
  // `registerExistingTenant` callers need a parent too.
  const parentOf = new Map<string, string | undefined>();

  const manageGrantKey = (refId: string, tenantId: string) =>
    `${refId}::${tenantId}`;

  // Mirrors the drizzle store's ancestor walk: true if `tenantId` is
  // `ancestorCandidateId` itself, or descends from it, using the same
  // parent links `moveChannelTenancy` updates on every move — so a
  // cycle this store already believes into existing (via a prior
  // `moveChannelTenancy` call) is caught exactly like the database
  // would catch it.
  function isSelfOrDescendantOf(
    tenantId: string,
    ancestorCandidateId: string,
  ): boolean {
    let cursor: string | undefined = ancestorCandidateId;
    const visited = new Set<string>();
    while (cursor !== undefined) {
      if (cursor === tenantId) return true;
      if (visited.has(cursor)) {
        throw new Error(
          `Tenant hierarchy cycle detected walking ancestors of ` +
            `"${ancestorCandidateId}", unrelated to this move`,
        );
      }
      visited.add(cursor);
      cursor = parentOf.get(cursor);
    }
    return false;
  }

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
      parentOf.set(tenantId, input.parentTenantId);
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

    async listChannelTenantIds(tenantIds) {
      const requested = new Set(tenantIds);
      const channelTenantIds = new Set(
        [...byChannelId.values()].map((row) => row.tenantId),
      );
      return new Set(
        [...requested].filter((tenantId) => channelTenantIds.has(tenantId)),
      );
    },

    async compensateChannelTenant(tenantId) {
      existingTenants.delete(tenantId);
      for (const [channelId, row] of byChannelId) {
        if (row.tenantId === tenantId) byChannelId.delete(channelId);
      }
    },

    registerExistingTenant(tenantId, parentTenantId) {
      existingTenants.add(tenantId);
      parentOf.set(tenantId, parentTenantId);
    },

    grantManageInTenant(refId, tenantId) {
      manageGrants.add(manageGrantKey(refId, tenantId));
    },

    registerPrincipal(tenantId, principalRow) {
      principalsByKey.set(
        principalKey(tenantId, principalRow.id),
        principalRow,
      );
    },

    async getTenantPrincipal(tenantId, principalId) {
      return principalsByKey.get(principalKey(tenantId, principalId));
    },

    // Mirrors the drizzle store's fold of the destination check into
    // the move itself: there is no separate pre-check call to race
    // against, in-memory or not — every failure mode is an outcome of
    // this one call.
    async moveChannelTenancy({ channelId, newParentTenantId, callerRefId }) {
      const existing = byChannelId.get(channelId);
      if (existing === undefined) {
        return { kind: "no_tenancy" as const };
      }
      if (!existingTenants.has(newParentTenantId)) {
        return { kind: "destination_not_found" as const };
      }
      if (isSelfOrDescendantOf(existing.tenantId, newParentTenantId)) {
        return { kind: "cycle" as const };
      }
      if (!manageGrants.has(manageGrantKey(callerRefId, newParentTenantId))) {
        return { kind: "forbidden" as const };
      }
      const moved: ChannelTenancyRow = {
        ...existing,
        parentTenantId: newParentTenantId,
      };
      byChannelId.set(channelId, moved);
      parentOf.set(existing.tenantId, newParentTenantId);
      return { kind: "moved" as const, row: moved };
    },
  };
}
