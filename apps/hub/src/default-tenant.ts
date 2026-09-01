// The hub's root tenant, ensured at boot instead of configured through
// the environment. Every self-served personal bench parents under this
// tenant, so it must exist before the first sign-in can provision one —
// boot is the one moment the hub can guarantee that ordering. The slug
// comes from WORKBENCH_DEFAULT_TENANT (default "workbench", see
// config.ts); the row's id becomes the runtime operatorTenantId handed
// to onboarding and the tenant-create guard.
//
// Boot also finishes setup itself: it seeds the operator's admin
// account (HUB_ADMIN_EMAIL/PASSWORD — the same identity `workbench
// setup` signs in as) and makes that account the root tenant's owner.
// Without the membership the root would have no members at all:
// `workbench setup` could never adopt it through its principals scan,
// its access-policy row would have no editor, and nothing could invite
// a second member. Every step is idempotent, so re-running boot (and
// every restart) is a no-op.

import { and, eq } from "drizzle-orm";
import { generateId } from "@intx/hub-common";
import type { DB } from "@intx/db";
import { grant, principal, principalRole, role, tenant } from "@intx/db/schema";

/**
 * The better-auth surface boot seeding needs, named structurally so the
 * seeding is testable without standing up a whole auth instance.
 */
export type BootAdminAuth = {
  $context: Promise<{
    internalAdapter: {
      findUserByEmail(email: string): Promise<{ user: { id: string } } | null>;
      createUser(user: {
        email: string;
        name: string;
        emailVerified: boolean;
      }): Promise<{ id: string }>;
      linkAccount(account: {
        userId: string;
        providerId: string;
        accountId: string;
        password: string;
      }): Promise<unknown>;
    };
    password: { hash(password: string): Promise<string> };
  }>;
};

const SYSTEM_ROLES = ["owner", "admin", "member"] as const;
type SystemRoleName = (typeof SYSTEM_ROLES)[number];

// Same shapes the native create-tenant route writes
// (vendor/intx/hub-api/src/routes/tenants.ts): a role row per system
// role, then role-targeted allow grants.
const SYSTEM_ROLE_GRANTS: Record<
  SystemRoleName,
  { resource: string; action: string }[]
> = {
  owner: [{ resource: "*", action: "*" }],
  admin: [
    { resource: "*", action: "read" },
    { resource: "*", action: "create" },
    { resource: "*", action: "manage" },
  ],
  member: [{ resource: "*", action: "read" }],
};

function tenantNameFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function ensureAdminUser(
  auth: BootAdminAuth,
  admin: { email: string; password: string },
): Promise<string> {
  const context = await auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(admin.email);
  if (existing !== null) return existing.user.id;

  const passwordHash = await context.password.hash(admin.password);
  const user = await context.internalAdapter.createUser({
    email: admin.email,
    name: admin.email.split("@")[0] ?? admin.email,
    // No mailer exists anywhere in this stack (see index.ts's
    // allowUnverifiedEmails note), and this address is operator-
    // configured rather than self-claimed — verifying it at the source
    // is the honest reading of "verified", not a bypass.
    emailVerified: true,
  });
  await context.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: passwordHash,
  });
  return user.id;
}

async function ensureSystemRole(
  db: DB["db"],
  tenantId: string,
  roleName: SystemRoleName,
): Promise<string> {
  const existing = await db
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.name, roleName)));
  if (existing.length > 0) {
    const row = existing[0];
    if (!row) {
      throw new Error(
        "ensureSystemRole: existing.length > 0 but existing[0] is missing",
      );
    }
    return row.id;
  }

  const now = new Date();
  const [inserted] = await db
    .insert(role)
    .values({
      id: generateId("role"),
      tenantId,
      name: roleName,
      description: `System ${roleName} role`,
      isSystem: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: role.id });
  if (!inserted) {
    throw new Error(
      "ensureSystemRole: insert returned no row; the role table is in an unexpected state",
    );
  }
  return inserted.id;
}

async function ensureSystemRoleGrants(
  db: DB["db"],
  tenantId: string,
  roleName: SystemRoleName,
  roleId: string,
): Promise<void> {
  for (const shape of SYSTEM_ROLE_GRANTS[roleName]) {
    const existing = await db
      .select({ id: grant.id })
      .from(grant)
      .where(
        and(
          eq(grant.tenantId, tenantId),
          eq(grant.roleId, roleId),
          eq(grant.resource, shape.resource),
          eq(grant.action, shape.action),
          eq(grant.effect, "allow"),
          eq(grant.origin, "system"),
        ),
      );
    if (existing.length > 0) continue;

    const now = new Date();
    await db.insert(grant).values({
      id: generateId("grant"),
      tenantId,
      roleId,
      resource: shape.resource,
      action: shape.action,
      effect: "allow",
      origin: "system",
      createdAt: now,
      updatedAt: now,
    });
  }
}

/**
 * Make `adminUserId` the root tenant's owner. A tenant the admin already
 * belongs to (at any role) or that already belongs to someone else is
 * left exactly as found — boot never rearranges existing memberships.
 */
async function ensureOwnerMembership(
  db: DB["db"],
  tenantId: string,
  adminUserId: string,
  ownerRoleId: string,
): Promise<void> {
  const adminMemberships = await db
    .select({ id: principal.id })
    .from(principal)
    .where(
      and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, "user"),
        eq(principal.refId, adminUserId),
      ),
    );
  if (adminMemberships.length > 0) return;

  const userMemberships = await db
    .select({ id: principal.id })
    .from(principal)
    .where(and(eq(principal.tenantId, tenantId), eq(principal.kind, "user")));
  if (userMemberships.length > 0) return;

  const now = new Date();
  await db
    .insert(principal)
    .values({
      id: generateId("principal"),
      tenantId,
      kind: "user",
      refId: adminUserId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const created = await db
    .select({ id: principal.id })
    .from(principal)
    .where(
      and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, "user"),
        eq(principal.refId, adminUserId),
      ),
    );
  if (created.length === 0) {
    throw new Error(
      "ensureDefaultTenant: owner-membership insert was a no-op but the " +
        "principal row cannot be read back; the principal table is in an " +
        "unexpected state",
    );
  }
  const createdPrincipal = created[0];
  if (!createdPrincipal) {
    throw new Error(
      "ensureDefaultTenant: created.length > 0 but created[0] is missing",
    );
  }

  await db.insert(principalRole).values({
    principalId: createdPrincipal.id,
    roleId: ownerRoleId,
    createdAt: now,
  });
}

/**
 * Return the id of the root tenant for `slug`, creating it when absent,
 * with the boot admin seeded as its owner. Race-safe: a concurrent boot
 * (or a previous boot) may insert the same slug between this boot's
 * select and insert, so the insert is `.onConflictDoNothing()` and the
 * post-insert re-select returns the winning row's id — every caller
 * converges on one tenant. Failure fails the boot loudly.
 */
export async function ensureDefaultTenant(
  db: DB["db"],
  auth: BootAdminAuth,
  admin: { email: string; password: string },
  slug: string,
): Promise<string> {
  // The membership references the admin user, so the user exists first.
  const adminUserId = await ensureAdminUser(auth, admin);

  const existing = await db
    .select({ id: tenant.id })
    .from(tenant)
    .where(eq(tenant.slug, slug));
  let tenantId: string;
  if (existing.length > 0) {
    const row = existing[0];
    if (!row) {
      throw new Error(
        "ensureDefaultTenant: existing.length > 0 but existing[0] is missing",
      );
    }
    tenantId = row.id;
  } else {
    await db
      .insert(tenant)
      .values({
        id: generateId("tenant"),
        name: tenantNameFromSlug(slug),
        slug,
        domain: `${slug}.localhost`,
        parentId: null,
      })
      .onConflictDoNothing();

    const winner = await db
      .select({ id: tenant.id })
      .from(tenant)
      .where(eq(tenant.slug, slug));
    if (winner.length === 0) {
      throw new Error(
        `ensureDefaultTenant: insert of root tenant ${JSON.stringify(slug)} ` +
          "was a no-op but the row cannot be read back; the tenant table is " +
          "in an unexpected state",
      );
    }
    const winnerRow = winner[0];
    if (!winnerRow) {
      throw new Error(
        "ensureDefaultTenant: winner.length > 0 but winner[0] is missing",
      );
    }
    tenantId = winnerRow.id;
  }

  const roleIds: Record<SystemRoleName, string> = {
    owner: await ensureSystemRole(db, tenantId, "owner"),
    admin: await ensureSystemRole(db, tenantId, "admin"),
    member: await ensureSystemRole(db, tenantId, "member"),
  };
  for (const roleName of SYSTEM_ROLES) {
    await ensureSystemRoleGrants(db, tenantId, roleName, roleIds[roleName]);
  }

  await ensureOwnerMembership(db, tenantId, adminUserId, roleIds.owner);

  return tenantId;
}
