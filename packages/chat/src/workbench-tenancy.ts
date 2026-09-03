// Workbenches as child tenants: minting the native tenant a workbench is
// anchored under, the chat-owned link table that records the
// parent↔child relationship (see `./schema.ts`'s `workbenchTenancy`),
// and the listing/move seams workbench owns because no native
// child-tenant listing or re-parenting route exists upstream (see
// `docs/workbench-tenancy.md`).
//
// Native tenants are minted through `POST /api/tenants` as the caller
// (the same path access-policy child-tenants and onboarding use). Extra
// member-role `room:*` grants are planted with `POST /api/tenants/:id/grants`
// using `origin: "creator"` — native POST records provenance-from-caller,
// not the `origin: "system"` SQL seed this module used to write. This
// module still reads native `tenant`/`principal`/`role`/`grant` rows for
// move and membership, and writes only `workbench_tenancy`.
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateId } from "@intx/hub-common";
import { grant, principal, principalRole, role, tenant } from "@intx/db/schema";
import { parseGrantRow } from "@intx/db";
import { evaluateGrants } from "@intx/authz";
import type { ConditionRegistry, GrantRule } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  paginatedSchema,
  PrincipalResponse,
  RoleResponse,
  TenantResponse,
} from "@intx/types";
import { reportError } from "@corbits/error-sink";
import { parseAs, type ApiCall } from "@corbits/hub-api-client";
import { workbenchTenancy } from "./schema";

const log = getLogger(["chat", "workbench-tenancy"]);

/**
 * The resource/action a caller must hold a `manage`-level grant for,
 * in the destination tenant, before a workbench can be moved there.
 * Mirrors the shape the mint's own owner/admin grants are seeded
 * with (see `createWorkbenchTenant` below): `resource: "*"` scoped by
 * `action`, so any role carrying platform-wide manage authority in
 * the destination tenant satisfies it.
 */
const MOVE_DESTINATION_RESOURCE = "workflow-run:*";
const MOVE_DESTINATION_ACTION = "manage";

/**
 * The member role's room grant pair (CL-6332): every workbench tenant's
 * `member` role carries `room:*` read AND write from the moment it is
 * minted, mirroring the pair `seed.ts` plants beside the run pair for
 * seeded principals (PR #95) — but on the role itself, not one
 * principal at a time, so a member-role principal (however it comes to
 * hold that role — the mint's own creator-adjacent seeding today, an
 * invite tomorrow) carries room write for its workbench by construction,
 * with no separate per-principal grant to mint or fall out of sync.
 */
const MEMBER_ROOM_GRANTS = [
  { resource: "room:*", action: "read" },
  { resource: "room:*", action: "write" },
] as const;

/**
 * A defensive ceiling on how many ancestors `tenantIsDescendantOf`
 * will walk before giving up. The tenant hierarchy this rollout can
 * observe is shallow (a bench and its workbenches), so a real chain this
 * long can only mean a cycle already exists somewhere in the tree that
 * predates this guard — surfacing that loudly (see the thrown error
 * below) beats spinning forever on data this code did not create.
 */
const MAX_ANCESTOR_WALK = 1000;

/**
 * Derives a URL-safe slug from a workbench's name, plus a random tail
 * for uniqueness. `tenant.slug` is unique across the whole platform,
 * so a workbench tenant can never collide with another workbench's, or
 * with a bench created through the native route — the tail is a
 * collision-avoidance measure, not a display detail, and is never
 * shown to a user.
 */
function slugForWorkbenchTenant(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const tail = generateId("tenant").slice(-8);
  return `${base !== "" ? base : "workbench"}-${tail}`;
}

function throwHttp(label: string, status: number, data: unknown): never {
  throw new Error(
    `${label} failed with status ${status}: ${JSON.stringify(data)}`,
  );
}

/**
 * Mints a native child tenant through `POST /api/tenants` as the caller,
 * then plants `MEMBER_ROOM_GRANTS` on the new tenant's `member` role.
 * Returns the native tenant plus the owner's principal id in that tenant.
 */
async function mintNativeChildTenant(
  api: ApiCall,
  cookies: string[],
  input: {
    name: string;
    slug: string;
    parentTenantId: string;
    creatorUserId: string;
  },
): Promise<{
  tenant: typeof TenantResponse.infer;
  ownerPrincipalId: string;
}> {
  const created = await api(
    "POST",
    "/api/tenants",
    {
      name: input.name,
      slug: input.slug,
      parentId: input.parentTenantId,
    },
    cookies,
  );
  if (created.status !== 201) {
    throwHttp("POST /api/tenants", created.status, created.data);
  }
  const minted = parseAs(TenantResponse, created.data, "tenant response");

  const principalsResponse = await api(
    "GET",
    `/api/tenants/${minted.id}/principals?limit=200`,
    undefined,
    cookies,
  );
  if (principalsResponse.status !== 200) {
    throwHttp(
      `GET /api/tenants/${minted.id}/principals`,
      principalsResponse.status,
      principalsResponse.data,
    );
  }
  const principals = parseAs(
    paginatedSchema(PrincipalResponse),
    principalsResponse.data,
    "principals response",
  );
  const membership = principals.data.find(
    (p) => p.refId === input.creatorUserId,
  );
  if (membership === undefined) {
    throw new Error(
      `tenant ${minted.id} was created but has no principal for ${input.creatorUserId}`,
    );
  }

  const rolesResponse = await api(
    "GET",
    `/api/tenants/${minted.id}/roles?limit=50`,
    undefined,
    cookies,
  );
  if (rolesResponse.status !== 200) {
    throwHttp(
      `GET /api/tenants/${minted.id}/roles`,
      rolesResponse.status,
      rolesResponse.data,
    );
  }
  const roles = parseAs(
    paginatedSchema(RoleResponse),
    rolesResponse.data,
    "roles response",
  );
  const memberRole = roles.data.find((r) => r.name === "member");
  if (memberRole === undefined) {
    throw new Error(`tenant ${minted.id} has no system "member" role`);
  }

  // Native POST records provenance-from-caller (`origin: "creator"`),
  // not the `origin: "system"` SQL this mint used to write.
  for (const seed of MEMBER_ROOM_GRANTS) {
    const posted = await api(
      "POST",
      `/api/tenants/${minted.id}/grants`,
      {
        roleId: memberRole.id,
        resource: seed.resource,
        action: seed.action,
        effect: "allow",
        origin: "creator",
      },
      cookies,
    );
    if (posted.status !== 201) {
      throwHttp(
        `POST /api/tenants/${minted.id}/grants ${seed.resource}/${seed.action}`,
        posted.status,
        posted.data,
      );
    }
  }

  return { tenant: minted, ownerPrincipalId: membership.id };
}

/**
 * In-memory stand-in for `POST /api/tenants` + role list + grant plant,
 * so unit tests exercise the same HTTP-shaped mint the drizzle store
 * uses without pretending to SQL-insert native rows.
 */
export function createInMemoryNativeTenantApi(): ApiCall {
  const minted: {
    id: string;
    name: string;
    slug: string;
    parentId?: string;
    principalId: string;
    memberRoleId: string;
  }[] = [];

  return async (method, path, body, cookies = []) => {
    if (method === "POST" && path === "/api/tenants") {
      const parsed = body as {
        name: string;
        slug: string;
        parentId?: string;
      };
      const id = generateId("tenant");
      const principalId = generateId("principal");
      const memberRoleId = generateId("role");
      const row: (typeof minted)[number] = {
        id,
        name: parsed.name,
        slug: parsed.slug,
        principalId,
        memberRoleId,
      };
      if (parsed.parentId !== undefined) row.parentId = parsed.parentId;
      minted.push(row);
      const data: Record<string, unknown> = {
        id,
        name: parsed.name,
        slug: parsed.slug,
        domain: `${parsed.slug}.localhost`,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      if (parsed.parentId !== undefined) data["parentId"] = parsed.parentId;
      return { status: 201, data, cookies };
    }
    const principalsMatch = /^\/api\/tenants\/([^/]+)\/principals/.exec(path);
    if (method === "GET" && principalsMatch !== null) {
      const tenantId = principalsMatch[1] ?? "";
      const row = minted.find((t) => t.id === tenantId);
      const principalId = row?.principalId ?? generateId("principal");
      return {
        status: 200,
        data: {
          data: [
            {
              id: principalId,
              tenantId,
              kind: "user",
              refId: "pending",
              displayName: row?.name ?? "owner",
              status: "active",
              roles: [{ id: "rol_owner", name: "owner" }],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
        cookies,
      };
    }
    const rolesMatch = /^\/api\/tenants\/([^/]+)\/roles/.exec(path);
    if (method === "GET" && rolesMatch !== null) {
      const tenantId = rolesMatch[1] ?? "";
      const row = minted.find((t) => t.id === tenantId);
      const memberRoleId = row?.memberRoleId ?? generateId("role");
      return {
        status: 200,
        data: {
          data: [
            {
              id: memberRoleId,
              tenantId,
              name: "member",
              description: "System member role",
              isSystem: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
        cookies,
      };
    }
    if (method === "POST" && /\/api\/tenants\/[^/]+\/grants$/.test(path)) {
      return { status: 201, data: {}, cookies };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
}

export type WorkbenchTenancyDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export interface WorkbenchTenancyRow {
  readonly workbenchId: string;
  readonly tenantId: string;
  readonly parentTenantId: string;
  readonly slug: string;
  readonly createdAt: Date;
}

export interface CreateWorkbenchTenantInput {
  readonly parentTenantId: string;
  readonly workbenchId: string;
  readonly name: string;
  /**
   * The auth user id (a principal's `refId`, never a principal's own
   * `id`) the child tenant's owner principal is minted for — the same
   * identity the creator already holds in the parent bench, given a
   * fresh principal and the child tenant's `owner` role, exactly as
   * `POST /api/tenants` seeds its creator.
   */
  readonly creatorUserId: string;
  /** The caller's session cookies, forwarded into native tenant/grant HTTP. */
  readonly cookies: string[];
}

export interface CreateWorkbenchTenantResult {
  readonly tenantId: string;
  readonly parentTenantId: string;
  readonly domain: string;
  readonly slug: string;
  readonly ownerPrincipalId: string;
}

export interface MoveWorkbenchTenancyInput {
  readonly workbenchId: string;
  readonly newParentTenantId: string;
  /** The caller's auth user id (`principal.refId`) — moving tenants
   * looks up whatever principal that identity holds in the
   * destination tenant, not the principal id the caller authenticated
   * with in its own tenant, since those are different rows. Checked
   * inside the same transaction that performs the move (see
   * `moveWorkbenchTenancy` below), never as a separate round trip, so a
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
 * workbench's own tenant, or a descendant of it, so completing the move
 * would make the workbench its own ancestor. This is a structural
 * rejection, not an authorization one — a caller can hold every grant
 * in the world and it is still refused, so it is reported separately
 * rather than folded into `"forbidden"`, which would misstate why the
 * move was refused. `"no_tenancy"` is the pre-existing "legacy
 * workbench" case: nothing to move. All four, and the successful
 * `"moved"` case, are reported by the same call so a route never has
 * to reconcile results from two separate reads of a fact that can
 * change between them.
 */
export type MoveWorkbenchTenancyOutcome =
  | { readonly kind: "moved"; readonly row: WorkbenchTenancyRow }
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
  readonly refId: string;
}

export interface WorkbenchTenancyStore {
  /**
   * Mints a native tenant as `input.workbenchId`'s own tenancy, parented
   * under `input.parentTenantId`, by calling `POST /api/tenants` as the
   * requesting user, planting the extra member-role room grants, and
   * recording the link in `workbench_tenancy`.
   */
  createWorkbenchTenant(
    input: CreateWorkbenchTenantInput,
  ): Promise<CreateWorkbenchTenantResult>;

  /** The workbench tenancy link row for one workbench, or `undefined` for
   * a workbench that predates this rollout (a legacy flat workbench — see
   * `docs/workbench-tenancy.md`) or was never anchored as a tenant. */
  getWorkbenchTenancy(
    workbenchId: string,
  ): Promise<WorkbenchTenancyRow | undefined>;

  /** Every workbench tenancy link parented under `parentTenantId` — the
   * workbench-owned answer to "list this bench's child tenants",
   * which no native route provides. */
  listChildWorkbenchTenancies(
    parentTenantId: string,
  ): Promise<WorkbenchTenancyRow[]>;

  /**
   * Which of `tenantIds` is itself a workbench's own tenant — the
   * workbench-owned answer to "is this a workbench or a workbench child
   * tenancy", since native tenant rows carry no such marker. Callers
   * (the bench switcher's memberships filter, chiefly) hold a list of
   * tenant ids from `/api/me/principals` and need to know which ones
   * to exclude, regardless of which parent each workbench belongs to.
   */
  listWorkbenchTenantIds(
    tenantIds: readonly string[],
  ): Promise<ReadonlySet<string>>;

  /**
   * Re-parents a workbench's tenancy, but only after re-verifying —
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
   * destination that is the workbench's own tenant or a descendant of
   * it, walking the destination's ancestor chain under the same locks
   * so the check can never observe a hierarchy that has since changed
   * out from under it. Returns `{ kind: "no_tenancy" }` for a workbench
   * with no tenancy link (nothing to move), checked before the
   * destination is even considered.
   */
  moveWorkbenchTenancy(
    input: MoveWorkbenchTenancyInput,
  ): Promise<MoveWorkbenchTenancyOutcome>;

  /**
   * Undoes a mint that a subsequent step (the workbench host launch)
   * failed to complete: deletes the `workbench_tenancy` link only.
   * Native tenant/role/grant/principal rows stay — compensation no
   * longer deletes Interchange tenants.
   */
  compensateWorkbenchTenant(tenantId: string): Promise<void>;

  /**
   * The native `principal` row for `principalId` within `tenantId`,
   * or `undefined` when no such principal exists there — the
   * validation a person-DM chat's `POST /workbenches` runs before
   * minting the second participant, so a stale or cross-tenant
   * `principalId` fails closed with an ordinary 400 rather than
   * silently seeding a participant record nothing backs. Reads the
   * native `principal` table directly, the same table this store's
   * own mint seeds an owner row into (see `createWorkbenchTenant`) —
   * not a workbench-tenancy concept on its own, but colocated here
   * since this is the one store in the package already holding a
   * `db` handle onto native tenancy tables.
   */
  getTenantPrincipal(
    tenantId: string,
    principalId: string,
  ): Promise<TenantPrincipal | undefined>;

  /**
   * The native principal row for whoever `refId` (the caller's own auth
   * user identity, `principal.refId`) resolves to within `tenantId`, or
   * `undefined` when that identity holds no principal there — the
   * membership check a members-only workbench's own child tenant gates
   * room access by (CL-6332): "invited" means the workbench's own
   * tenant minted a principal for this identity, with no separate
   * membership table to fall out of sync with it. Unlike
   * `getTenantPrincipal`, which looks up a principal already known to
   * belong to `tenantId`, this crosses tenant boundaries by the one
   * identity that stays stable across every tenant it holds a
   * principal in.
   */
  getTenantPrincipalByRefId(
    tenantId: string,
    refId: string,
  ): Promise<TenantPrincipal | undefined>;

  /**
   * Invites `refId` into `workbenchId`'s own child tenant as a `member`
   * — the CL-6332 mint precedent (mirroring `createWorkbenchTenant`'s
   * own owner mint, above) applied to a second, non-creator principal.
   * The member role already carries the `room:*` read/write pair by
   * construction (see `MEMBER_ROOM_GRANTS`), so this one insert is the
   * whole invite: no separate grant to mint alongside it. Idempotent —
   * a `refId` that already holds a principal in this tenant (the
   * creator inviting themselves again, or a double-submit) is returned
   * as-is, never duplicated. Returns `undefined` for a workbench with
   * no tenancy link at all (a legacy workbench predating workbench
   * tenancy — see `docs/workbench-tenancy.md` — has no child tenant to
   * invite anyone into).
   */
  addWorkbenchMember(input: {
    readonly workbenchId: string;
    readonly refId: string;
  }): Promise<
    { readonly tenantId: string; readonly principalId: string } | undefined
  >;

  /**
   * The auth user id (`principal.refId`) of an active owner-role principal
   * in `tenantId`, or `undefined` when none is present — used by mint-dm
   * to seed a new agent chat's child tenant with the human bench owner as
   * creator, without the workflow child inventing a user id.
   */
  getWorkbenchOwnerUserId(tenantId: string): Promise<string | undefined>;
}

export interface WorkbenchTenancyAuthzDeps {
  /**
   * Passed straight through to `evaluateGrants` for the destination
   * check `moveWorkbenchTenancy` runs inside its own transaction — no
   * `GrantStore` here, deliberately: a `GrantStore` (as `requireGrant`
   * uses) always reads outside any caller-supplied transaction, which
   * is exactly the two-round-trip shape that let authorization and the
   * write it gated drift apart. The destination check instead collects
   * and locks its own grant rows directly against the move's own `tx`
   * (see `moveWorkbenchTenancy`).
   */
  readonly conditionRegistry?: ConditionRegistry;
  /** Self-HTTP caller used to mint native tenants and extra grants. */
  readonly api: ApiCall;
}

/**
 * The production `WorkbenchTenancyStore`, operating on `@intx/db`'s
 * native `tenant`/`principal`/`role`/`principalRole`/`grant` tables
 * (read/move/membership) plus this package's own `workbench_tenancy`
 * link table. Native tenant minting is HTTP, never a SQL insert.
 */
export function createDrizzleWorkbenchTenancyStore<
  TSchema extends Record<string, unknown>,
>(
  db: WorkbenchTenancyDb<TSchema>,
  authz: WorkbenchTenancyAuthzDeps,
): WorkbenchTenancyStore {
  return {
    async createWorkbenchTenant(input) {
      const slug = slugForWorkbenchTenant(input.name);
      let minted: Awaited<ReturnType<typeof mintNativeChildTenant>>;
      try {
        minted = await mintNativeChildTenant(authz.api, input.cookies, {
          name: input.name,
          slug,
          parentTenantId: input.parentTenantId,
          creatorUserId: input.creatorUserId,
        });
      } catch (cause) {
        reportError(cause, {
          operation: "createWorkbenchTenant",
          tenantId: input.parentTenantId,
          extra: { workbenchId: input.workbenchId },
        });
        throw cause;
      }
      const now = new Date();
      await db.insert(workbenchTenancy).values({
        workbenchId: input.workbenchId,
        tenantId: minted.tenant.id,
        parentTenantId: input.parentTenantId,
        slug: minted.tenant.slug,
        createdAt: now,
      });

      return {
        tenantId: minted.tenant.id,
        parentTenantId: input.parentTenantId,
        domain: minted.tenant.domain,
        slug: minted.tenant.slug,
        ownerPrincipalId: minted.ownerPrincipalId,
      };
    },

    async getWorkbenchTenancy(workbenchId) {
      const [row] = await db
        .select()
        .from(workbenchTenancy)
        .where(eq(workbenchTenancy.workbenchId, workbenchId))
        .limit(1);
      return row;
    },

    async listChildWorkbenchTenancies(parentTenantId) {
      return db
        .select()
        .from(workbenchTenancy)
        .where(eq(workbenchTenancy.parentTenantId, parentTenantId));
    },

    async listWorkbenchTenantIds(tenantIds) {
      if (tenantIds.length === 0) return new Set();
      const rows = await db
        .select({ tenantId: workbenchTenancy.tenantId })
        .from(workbenchTenancy)
        .where(inArray(workbenchTenancy.tenantId, tenantIds));
      return new Set(rows.map((row) => row.tenantId));
    },

    async moveWorkbenchTenancy({
      workbenchId,
      newParentTenantId,
      callerRefId,
    }) {
      return db.transaction(async (tx) => {
        // Locks the link row for the lifetime of this transaction —
        // a second, concurrent move of the same workbench blocks here
        // rather than racing this one to a write.
        const [linkRow] = await tx
          .select()
          .from(workbenchTenancy)
          .where(eq(workbenchTenancy.workbenchId, workbenchId))
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

        // Reject a move that would make the workbench its own ancestor:
        // the destination is the workbench's own tenant (a self-parent),
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
          .update(workbenchTenancy)
          .set({ parentTenantId: newParentTenantId })
          .where(eq(workbenchTenancy.workbenchId, workbenchId))
          .returning();
        if (movedLink === undefined) {
          throw new Error(
            `Workbench tenancy for "${workbenchId}" vanished mid-transaction`,
          );
        }
        await tx
          .update(tenant)
          .set({ parentId: newParentTenantId, updatedAt: now })
          .where(eq(tenant.id, movedLink.tenantId));

        return { kind: "moved" as const, row: movedLink };
      });
    },

    async compensateWorkbenchTenant(tenantId) {
      log.error(
        "Compensating workbench tenant {tenantId}: deleting the workbench_tenancy link after a downstream failure. Native tenant rows stay.",
        { tenantId },
      );
      await db
        .delete(workbenchTenancy)
        .where(eq(workbenchTenancy.tenantId, tenantId));
    },

    async getTenantPrincipal(tenantId, principalId) {
      const [row] = await db
        .select({
          id: principal.id,
          kind: principal.kind,
          status: principal.status,
          refId: principal.refId,
        })
        .from(principal)
        .where(
          and(eq(principal.tenantId, tenantId), eq(principal.id, principalId)),
        )
        .limit(1);
      return row as TenantPrincipal | undefined;
    },

    async getTenantPrincipalByRefId(tenantId, refId) {
      const [row] = await db
        .select({
          id: principal.id,
          kind: principal.kind,
          status: principal.status,
          refId: principal.refId,
        })
        .from(principal)
        .where(
          and(eq(principal.tenantId, tenantId), eq(principal.refId, refId)),
        )
        .limit(1);
      return row as TenantPrincipal | undefined;
    },

    async addWorkbenchMember({ workbenchId, refId }) {
      const [link] = await db
        .select()
        .from(workbenchTenancy)
        .where(eq(workbenchTenancy.workbenchId, workbenchId))
        .limit(1);
      if (link === undefined) return undefined;

      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: principal.id })
          .from(principal)
          .where(
            and(
              eq(principal.tenantId, link.tenantId),
              eq(principal.refId, refId),
            ),
          )
          .limit(1);
        if (existing !== undefined) {
          return { tenantId: link.tenantId, principalId: existing.id };
        }

        const [memberRole] = await tx
          .select({ id: role.id })
          .from(role)
          .where(and(eq(role.tenantId, link.tenantId), eq(role.name, "member")))
          .limit(1);
        if (memberRole === undefined) {
          throw new Error(
            `Workbench tenant "${link.tenantId}" has no "member" system role`,
          );
        }

        const now = new Date();
        const principalId = generateId("principal");
        await tx.insert(principal).values({
          id: principalId,
          tenantId: link.tenantId,
          kind: "user",
          refId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(principalRole).values({
          principalId,
          roleId: memberRole.id,
          createdAt: now,
        });

        return { tenantId: link.tenantId, principalId };
      });
    },

    async getWorkbenchOwnerUserId(tenantId) {
      const [row] = await db
        .select({ refId: principal.refId })
        .from(principal)
        .innerJoin(principalRole, eq(principalRole.principalId, principal.id))
        .innerJoin(role, eq(role.id, principalRole.roleId))
        .where(
          and(
            eq(principal.tenantId, tenantId),
            eq(principal.kind, "user"),
            eq(principal.status, "active"),
            eq(role.tenantId, tenantId),
            eq(role.name, "owner"),
          ),
        )
        .limit(1);
      return row?.refId;
    },
  };
}

/**
 * An in-memory `WorkbenchTenancyStore`, for tests and any host wiring
 * chat routes without a database. Mints native tenants through the
 * injected `ApiCall` (defaulting to `createInMemoryNativeTenantApi`)
 * and records only the chat-owned link — the same HTTP-shaped mint
 * the drizzle store uses.
 *
 * The three extra methods below `WorkbenchTenancyStore` declares
 * (`registerExistingTenant`, `grantManageInTenant`, `registerPrincipal`)
 * are test-support only: `registerExistingTenant` takes an optional
 * parent so a unit test can build an arbitrary tenant hierarchy without
 * a database. Together they let a test stand up "a real tenant the
 * caller has no standing in", "a real tenant the caller manages", and a
 * cyclic hierarchy, exercising `moveWorkbenchTenancy`'s destination-check
 * outcomes (`"destination_not_found"`, `"cycle"`, `"forbidden"`,
 * `"moved"`). `registerPrincipal` does the same for `getTenantPrincipal`
 * — standing up a fake native `principal` row without a database.
 */
export function createInMemoryWorkbenchTenancyStore(
  deps: {
    api?: ApiCall;
  } = {},
): WorkbenchTenancyStore & {
  registerExistingTenant(tenantId: string, parentTenantId?: string): void;
  grantManageInTenant(refId: string, tenantId: string): void;
  registerPrincipal(tenantId: string, principal: TenantPrincipal): void;
} {
  const inner = deps.api ?? createInMemoryNativeTenantApi();
  let pendingCreatorUserId = "";
  const api: ApiCall = async (method, path, body, cookies) => {
    const result = await inner(method, path, body, cookies);
    if (
      method === "GET" &&
      /\/api\/tenants\/[^/]+\/principals/.test(path) &&
      result.status === 200 &&
      result.data !== null &&
      typeof result.data === "object" &&
      "data" in result.data
    ) {
      const page = result.data as { data: Record<string, unknown>[] };
      return {
        ...result,
        data: {
          ...page,
          data: page.data.map((row) => ({
            ...row,
            refId: pendingCreatorUserId,
          })),
        },
      };
    }
    return result;
  };
  const byWorkbenchId = new Map<string, WorkbenchTenancyRow>();
  const existingTenants = new Set<string>();
  const manageGrants = new Set<string>();
  const principalsByKey = new Map<string, TenantPrincipal>();
  const principalsByRefKey = new Map<string, TenantPrincipal>();
  /** Owner `refId` per tenant — seeded by `createWorkbenchTenant`, and by
   * `grantManageInTenant` when a test stands up a root bench owner without
   * minting a child workbench. */
  const ownerRefByTenant = new Map<string, string>();
  const principalKey = (tenantId: string, principalId: string) =>
    `${tenantId}::${principalId}`;
  const refKey = (tenantId: string, refId: string) => `${tenantId}::${refId}`;
  // Mirrors the drizzle store's `tenant.parentId`: every tenant this
  // store knows of maps to its parent, or `undefined` for a root. Kept
  // separately from `byWorkbenchId` because a destination tenant in a
  // cycle test is often not itself a workbench's tenancy — plain
  // `registerExistingTenant` callers need a parent too.
  const parentOf = new Map<string, string | undefined>();

  const manageGrantKey = (refId: string, tenantId: string) =>
    `${refId}::${tenantId}`;

  // Mirrors the drizzle store's ancestor walk: true if `tenantId` is
  // `ancestorCandidateId` itself, or descends from it, using the same
  // parent links `moveWorkbenchTenancy` updates on every move — so a
  // cycle this store already believes into existing (via a prior
  // `moveWorkbenchTenancy` call) is caught exactly like the database
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
    async createWorkbenchTenant(input) {
      if (byWorkbenchId.has(input.workbenchId)) {
        throw new Error(
          `Workbench "${input.workbenchId}" already has a tenancy`,
        );
      }
      const slug = slugForWorkbenchTenant(input.name);
      pendingCreatorUserId = input.creatorUserId;
      let minted: Awaited<ReturnType<typeof mintNativeChildTenant>>;
      try {
        minted = await mintNativeChildTenant(api, input.cookies, {
          name: input.name,
          slug,
          parentTenantId: input.parentTenantId,
          creatorUserId: input.creatorUserId,
        });
      } catch (cause) {
        reportError(cause, {
          operation: "createWorkbenchTenant",
          tenantId: input.parentTenantId,
          extra: { workbenchId: input.workbenchId },
        });
        throw cause;
      }
      const tenantId = minted.tenant.id;
      const row: WorkbenchTenancyRow = {
        workbenchId: input.workbenchId,
        tenantId,
        parentTenantId: input.parentTenantId,
        slug: minted.tenant.slug,
        createdAt: new Date(),
      };
      byWorkbenchId.set(input.workbenchId, row);
      existingTenants.add(tenantId);
      parentOf.set(tenantId, input.parentTenantId);
      // The creator is minted as this tenant's owner, exactly as the
      // native POST /api/tenants route does — the owner role's `*`/`*`
      // grant covers the move-destination check too.
      manageGrants.add(manageGrantKey(input.creatorUserId, tenantId));
      const ownerPrincipalId = minted.ownerPrincipalId;
      const ownerPrincipal: TenantPrincipal = {
        id: ownerPrincipalId,
        kind: "user",
        status: "active",
        refId: input.creatorUserId,
      };
      principalsByKey.set(
        principalKey(tenantId, ownerPrincipalId),
        ownerPrincipal,
      );
      principalsByRefKey.set(
        refKey(tenantId, input.creatorUserId),
        ownerPrincipal,
      );
      ownerRefByTenant.set(tenantId, input.creatorUserId);
      return {
        tenantId,
        parentTenantId: input.parentTenantId,
        domain: minted.tenant.domain,
        slug: minted.tenant.slug,
        ownerPrincipalId,
      };
    },

    async getWorkbenchTenancy(workbenchId) {
      return byWorkbenchId.get(workbenchId);
    },

    async listChildWorkbenchTenancies(parentTenantId) {
      return [...byWorkbenchId.values()].filter(
        (row) => row.parentTenantId === parentTenantId,
      );
    },

    async listWorkbenchTenantIds(tenantIds) {
      const requested = new Set(tenantIds);
      const workbenchTenantIds = new Set(
        [...byWorkbenchId.values()].map((row) => row.tenantId),
      );
      return new Set(
        [...requested].filter((tenantId) => workbenchTenantIds.has(tenantId)),
      );
    },

    async compensateWorkbenchTenant(tenantId) {
      for (const [workbenchId, row] of byWorkbenchId) {
        if (row.tenantId === tenantId) byWorkbenchId.delete(workbenchId);
      }
    },

    registerExistingTenant(tenantId, parentTenantId) {
      existingTenants.add(tenantId);
      parentOf.set(tenantId, parentTenantId);
    },

    grantManageInTenant(refId, tenantId) {
      manageGrants.add(manageGrantKey(refId, tenantId));
      // A test seeding a root bench owner (no createWorkbenchTenant) still
      // needs getWorkbenchOwnerUserId to resolve — treat the manage grant
      // as the owner marker when none is recorded yet.
      if (!ownerRefByTenant.has(tenantId)) {
        ownerRefByTenant.set(tenantId, refId);
      }
    },

    registerPrincipal(tenantId, principalRow) {
      principalsByKey.set(
        principalKey(tenantId, principalRow.id),
        principalRow,
      );
      principalsByRefKey.set(
        refKey(tenantId, principalRow.refId),
        principalRow,
      );
    },

    async getTenantPrincipal(tenantId, principalId) {
      return principalsByKey.get(principalKey(tenantId, principalId));
    },

    async getTenantPrincipalByRefId(tenantId, refId) {
      return principalsByRefKey.get(refKey(tenantId, refId));
    },

    async getWorkbenchOwnerUserId(tenantId) {
      return ownerRefByTenant.get(tenantId);
    },

    // Mirrors the drizzle store's fold of the destination check into
    // the move itself: there is no separate pre-check call to race
    // against, in-memory or not — every failure mode is an outcome of
    // this one call.
    async moveWorkbenchTenancy({
      workbenchId,
      newParentTenantId,
      callerRefId,
    }) {
      const existing = byWorkbenchId.get(workbenchId);
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
      const moved: WorkbenchTenancyRow = {
        ...existing,
        parentTenantId: newParentTenantId,
      };
      byWorkbenchId.set(workbenchId, moved);
      parentOf.set(existing.tenantId, newParentTenantId);
      return { kind: "moved" as const, row: moved };
    },

    async addWorkbenchMember({ workbenchId, refId }) {
      const link = byWorkbenchId.get(workbenchId);
      if (link === undefined) return undefined;

      const existing = principalsByRefKey.get(refKey(link.tenantId, refId));
      if (existing !== undefined) {
        return { tenantId: link.tenantId, principalId: existing.id };
      }

      const principalId = generateId("principal");
      const memberPrincipal: TenantPrincipal = {
        id: principalId,
        kind: "user",
        status: "active",
        refId,
      };
      principalsByKey.set(
        principalKey(link.tenantId, principalId),
        memberPrincipal,
      );
      principalsByRefKey.set(refKey(link.tenantId, refId), memberPrincipal);
      return { tenantId: link.tenantId, principalId };
    },
  };
}
