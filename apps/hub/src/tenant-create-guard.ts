// [Intx gap] CL-6041: the native `POST /api/tenants` route
// (vendor/intx/hub-api/src/routes/tenants.ts) is ungated — any
// authenticated user can call it directly, pick an arbitrary
// `parentId`, and become owner of a freshly-minted child under ANY
// tenant, or mint a top-level tenant, entirely bypassing
// `@workbench/access-policy`. Filed upstream; vendor is read-only, so
// this hub composes a guard in front of the whole native app instead of
// patching the route. `@workbench/access-policy`'s own
// `POST .../child-tenants` wrapper (mounted by
// `createAccessPolicyRoutes`) stays as the polished UI surface — a
// clean pre-flight 403 with a helpful message — but the actual
// enforcement lives here, in front of the primitive itself, since a
// caller can always skip the wrapper and hit the native route directly.
//
// Registered by wrapping: a fresh outer Hono app gets this guard
// middleware for the exact `/api/tenants` path registered FIRST, then
// mounts the fully-built native+extension app underneath via
// `.route("/", nativeApp)`. Hono composes handlers in registration
// order, so a request the guard denies never reaches the mounted app at
// all; one it allows falls through via `next()`.
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { principal, principalRole, role } from "@intx/db/schema";
import type { DB } from "@intx/db";
import type { AppEnv } from "@intx/hub-api";
import {
  canCreateTenancy,
  checkSignupGate,
  type AccessPolicyStore,
} from "@workbench/access-policy";
import { makeErrorEnvelope } from "@corbits/error-sink";

const NATIVE_TENANT_CREATE_PATH = "/api/tenants";

export type TenantCreateGuardDeps = {
  store: AccessPolicyStore;
  /** Native role names the caller holds in `tenantId`, or `undefined`
   * when they have no principal there at all (not a member). Production
   * wiring is `(tenantId, userId) => resolveCallerRoleNames(db, tenantId, userId)`;
   * kept as an injected function (rather than a raw `db` handle) so the
   * guard's own decision logic is testable without a database. */
  resolveCallerRoleNames: (
    tenantId: string,
    userId: string,
  ) => Promise<readonly string[] | undefined>;
  operatorTenantId?: string;
  envSignupMode: "open" | "closed";
  envAllowedDomains: readonly string[];
  allowUnverifiedEmails: boolean;
  getSessionUser: (
    headers: Headers,
  ) => Promise<
    { id: string; email: string; emailVerified: boolean } | undefined
  >;
};

export type TenantCreateGuardVerdict =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; code: string; message: string };

/** Native role names this user's principal holds in `tenantId` —
 * `undefined` when they have no principal there at all (not a member),
 * matching exactly what `vendor/intx/hub-api/src/routes/principals.ts`'s
 * `loadRolesForPrincipal` reads, just filtered down to names. Reads
 * native tables directly; declares none of its own (see
 * `scripts/checks/no-product-tenancy.ts`). */
export async function resolveCallerRoleNames(
  db: DB["db"],
  tenantId: string,
  userId: string,
): Promise<readonly string[] | undefined> {
  const principalRow = await db.query.principal.findFirst({
    where: and(
      eq(principal.tenantId, tenantId),
      eq(principal.kind, "user"),
      eq(principal.refId, userId),
    ),
  });
  if (principalRow === undefined) return undefined;

  const assignments = await db.query.principalRole.findMany({
    where: eq(principalRole.principalId, principalRow.id),
  });
  if (assignments.length === 0) return [];

  const roleIds = assignments.map((a) => a.roleId);
  const roles = await db.query.role.findMany({
    where: inArray(role.id, roleIds),
  });
  return roles.map((r) => r.name);
}

/**
 * The decision itself, given already-resolved inputs. A `parentId`
 * equal to the operator tenant (or no `parentId` at all) is the
 * self-service landing zone — governed by the signup gate, the same
 * decision `packages/onboarding`'s first-login hook makes, so a
 * hand-crafted request answers identically to the real onboarding flow.
 * Any other `parentId` is an explicit sub-workbench create and requires
 * the caller to already be a member of that exact tenant with a role
 * this tenant's own `tenancyCreation` policy accepts — an attacker who
 * is not a member of the target tenant can never satisfy this, however
 * they picked the id.
 */
export async function decideTenantCreate(
  deps: TenantCreateGuardDeps,
  request: {
    parentId?: string;
    userId: string;
    userEmail: string;
    userEmailVerified: boolean;
  },
): Promise<TenantCreateGuardVerdict> {
  if (
    request.parentId === undefined ||
    request.parentId === deps.operatorTenantId
  ) {
    type MutableSignupGateArgs = {
      -readonly [K in keyof Parameters<typeof checkSignupGate>[0]]: Parameters<
        typeof checkSignupGate
      >[0][K];
    };
    const gateArgs: MutableSignupGateArgs = {
      store: deps.store,
      envSignupMode: deps.envSignupMode,
      envAllowedDomains: deps.envAllowedDomains,
      email: request.userEmail,
      emailVerified: request.userEmailVerified,
      allowUnverifiedEmails: deps.allowUnverifiedEmails,
    };
    if (deps.operatorTenantId !== undefined) {
      gateArgs.operatorTenantId = deps.operatorTenantId;
    }
    const gate = await checkSignupGate(gateArgs);
    if (!gate.allowed) {
      return {
        allowed: false,
        status: 403,
        code: "signup_not_allowed",
        message:
          gate.reason === "email_unverified"
            ? "This account's email address isn't verified, and this hub " +
              "requires verified emails before provisioning. For local " +
              "development set ALLOW_UNVERIFIED_EMAILS=1 in .env and " +
              "restart."
            : "This workbench isn't open for self-serve sign-up right now. " +
              "Ask an owner for an invite.",
      };
    }
    return { allowed: true };
  }

  const parentId = request.parentId;
  const roleNames = await deps.resolveCallerRoleNames(parentId, request.userId);
  if (roleNames === undefined) {
    return {
      allowed: false,
      status: 403,
      code: "not_a_member",
      message:
        "You need to already belong to that workbench to create a sub-workbench under it.",
    };
  }

  const policy = await deps.store.getPolicy(parentId);
  if (!canCreateTenancy(policy, roleNames)) {
    return {
      allowed: false,
      status: 403,
      code: "tenancy_creation_forbidden",
      message:
        "This workbench's policy doesn't allow you to create a sub-workbench here.",
    };
  }
  return { allowed: true };
}

function parseParentId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const parentId = (body as { parentId?: unknown }).parentId;
  return typeof parentId === "string" && parentId.length > 0
    ? parentId
    : undefined;
}

/**
 * Wraps `nativeApp` (the fully-built hub app, native tenant route
 * included) inside a fresh outer app that guards `POST /api/tenants`
 * ahead of it. Every other path falls straight through unguarded.
 */
export function guardedHubApp(
  nativeApp: Hono<AppEnv>,
  deps: TenantCreateGuardDeps,
): Hono<AppEnv> {
  const guarded = new Hono<AppEnv>();

  guarded.use(NATIVE_TENANT_CREATE_PATH, async (c, next) => {
    if (c.req.method !== "POST") return next();

    const user = await deps.getSessionUser(c.req.raw.headers);
    if (user === undefined) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage: "Authentication required",
        }),
        401,
      );
    }

    // Malformed JSON: let the native route produce its own 400 — there
    // is no parentId to branch on either way, so this falls into the
    // self-service signup-gate branch same as "no parentId".
    const body: unknown = await c.req.raw
      .clone()
      .json()
      .catch(() => ({}));

    const parentId = parseParentId(body);
    const decideRequest: Parameters<typeof decideTenantCreate>[1] = {
      userId: user.id,
      userEmail: user.email,
      userEmailVerified: user.emailVerified,
    };
    if (parentId !== undefined) {
      decideRequest.parentId = parentId;
    }
    const verdict = await decideTenantCreate(deps, decideRequest);
    if (!verdict.allowed) {
      return c.json(
        makeErrorEnvelope({
          code: verdict.code,
          userMessage: verdict.message,
        }),
        verdict.status,
      );
    }
    return next();
  });

  guarded.route("/", nativeApp);
  return guarded;
}
