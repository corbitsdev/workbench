import { authorize, type GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  ADMIN_ACTION,
  ADMIN_RESOURCE,
  OWNER_ACTION,
  OWNER_RESOURCE,
} from "@workbench/shared";
import type { MiddlewareHandler } from "hono";
import type { HubDb } from "../db";
import { ensureMember } from "./tenant-provisioning";

const log = getLogger(["api", "admin-grant"]);

// Whether a principal holds admin authority in a tenant, resolved through
// Interchange's NATIVE grant model. "Admin" is not a bespoke flag: the `admin`
// system role bears `*`/{read,create,manage} and `owner` bears `*`/`*`, so an
// `authorize` for a broad resource with the `manage` action is satisfied only
// by those roles' wildcard grants — a plain member (no role grants) is denied.
// Fail-closed: anything but an explicit `allow` is not admin.
export async function isAdmin(
  grantStore: GrantStore,
  principalId: string,
  tenantId: string,
): Promise<boolean> {
  const result = await authorize(
    grantStore,
    principalId,
    tenantId,
    ADMIN_RESOURCE,
    ADMIN_ACTION,
  );
  return result.effect === "allow";
}

// Whether a principal holds OWNER authority in a tenant, resolved through the
// SAME native grant model as isAdmin. This gates on tenant-wide wildcard
// authority: it probes `OWNER_RESOURCE`/`OWNER_ACTION`, which only a `*`/`*`
// (or otherwise `own`-globbing) grant satisfies. The seeded `admin` role bears
// `*`/{read,create,manage} — none of which match `own` — so an admin is denied;
// the `owner` role's `*`/`*` is the sole holder today (see OWNER_ACTION for the
// exact invariant). Fail-closed: anything but an explicit `allow` is not owner.
export async function isOwner(
  grantStore: GrantStore,
  principalId: string,
  tenantId: string,
): Promise<boolean> {
  const result = await authorize(
    grantStore,
    principalId,
    tenantId,
    OWNER_RESOURCE,
    OWNER_ACTION,
  );
  return result.effect === "allow";
}

// Hono middleware that authorizes the session caller as an admin and stashes
// their global-tenant principal id on the context for the handlers to reuse.
// Mirrors `createWorkflowDeployGrantGuard`: resolve the caller's principal in
// the root tenant, then `authorize` against the admin capability. Fail-closed
// (403) on anything but allow. This is the SERVER-SIDE enforcement of the admin
// area — the web nav gate is cosmetic; this guard is authoritative.
export function createAdminGrantGuard(deps: {
  db: HubDb;
  grantStore: GrantStore;
  rootTenantId: string;
}): MiddlewareHandler<{
  Variables: { userId: string; adminPrincipalId: string };
}> {
  return async (c, next) => {
    const userId = c.get("userId");
    const { principalId } = await ensureMember(deps.db, {
      tenantId: deps.rootTenantId,
      userId,
    });
    const allowed = await isAdmin(
      deps.grantStore,
      principalId,
      deps.rootTenantId,
    );
    if (!allowed) {
      log.info("admin area access denied", { principalId });
      return c.json(
        { error: "You do not have permission to access the admin area" },
        403,
      );
    }
    c.set("adminPrincipalId", principalId);
    return next();
  };
}

// Hono middleware that authorizes the session caller as an OWNER and stashes
// their root-tenant principal id on the context. Mirrors createAdminGrantGuard
// but gates on owner authority: an admin who is not an owner is denied (403).
// The web `/owner` nav gate is cosmetic; this guard is authoritative.
export function createOwnerGrantGuard(deps: {
  db: HubDb;
  grantStore: GrantStore;
  rootTenantId: string;
}): MiddlewareHandler<{
  Variables: { userId: string; ownerPrincipalId: string };
}> {
  return async (c, next) => {
    const userId = c.get("userId");
    const { principalId } = await ensureMember(deps.db, {
      tenantId: deps.rootTenantId,
      userId,
    });
    const allowed = await isOwner(
      deps.grantStore,
      principalId,
      deps.rootTenantId,
    );
    if (!allowed) {
      log.info("owner area access denied", { principalId });
      return c.json(
        { error: "You do not have permission to access the owner area" },
        403,
      );
    }
    c.set("ownerPrincipalId", principalId);
    return next();
  };
}
