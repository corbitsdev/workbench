import { eq, and } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { generateId } from '@intx/hub-common';

const log = getLogger(['api', 'tenant-provisioning']);

const { tenant, principal, role, principalRole, grant } = intxSchema;

type ProductionDB = DB['db'];

// Narrower structural type for tests only — satisfies transaction contract.
export type ProvisioningDB = {
  transaction: <T>(fn: (tx: ProvisioningDB) => Promise<T>) => Promise<T>;
  query: {
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    tenant: { findFirst: (opts: any) => Promise<{ id: string; slug: string } | undefined> };
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    principal: { findFirst: (opts: any) => Promise<{ id: string } | undefined> };
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    role: { findFirst: (opts: any) => Promise<{ id: string } | undefined> };
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    grant: { findFirst: (opts: any) => Promise<{ id: string } | undefined> };
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
  insert: (table: any) => {
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    values: (values: any) => {
      returning?: () => Promise<unknown[]>;
      onConflictDoNothing?: () => Promise<unknown[]>;
    };
  };
};

const SYSTEM_ROLES = ['owner', 'admin', 'member'] as const;

type PersonalTenantResult = { tenantId: string };
type WorkbenchTenantResult = { tenantId: string };
type WorkbenchPrincipalResult = { principalId: string };

/**
 * Ensure a personal tenant exists for a workbench user. Idempotent — if the
 * tenant slug already exists, returns its ID without inserting anything.
 */
export async function provisionPersonalTenant(
  db: ProductionDB,
  opts: { userId: string; userEmail: string }
): Promise<PersonalTenantResult> {
  const slug = `user-${opts.userId}`;

  const existing = await db.query.tenant.findFirst({
    where: eq(tenant.slug, slug),
  });
  if (existing) {
    log.info('Personal tenant already exists', { userId: opts.userId, tenantId: existing.id });
    return { tenantId: existing.id };
  }

  return db.transaction(async (tx) => {
    const tenantId = generateId('tenant');
    const domain = `${slug}.localhost`;
    const now = new Date();

    let resolvedTenantId: string;

    try {
      const tenantRows = await tx
        .insert(tenant)
        .values({
          id: tenantId,
          name: opts.userEmail,
          slug,
          domain,
          parentId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const tenantRow = tenantRows[0];
      if (!tenantRow) throw new Error(`Failed to create personal tenant for user ${opts.userId}`);
      resolvedTenantId = (tenantRow as { id: string }).id;
    } catch (err) {
      const existingOnConflict = await tx.query.tenant.findFirst({
        where: eq(tenant.slug, slug),
      });
      if (existingOnConflict) return { tenantId: existingOnConflict.id };
      throw err;
    }

    const roleIds: Record<string, string> = {};
    for (const roleName of SYSTEM_ROLES) {
      const roleId = generateId('role');
      roleIds[roleName] = roleId;
      await tx.insert(role).values({
        id: roleId,
        tenantId: resolvedTenantId,
        name: roleName,
        description: `System ${roleName} role`,
        isSystem: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    const ownerRoleId = roleIds['owner'];
    const adminRoleId = roleIds['admin'];
    const memberRoleId = roleIds['member'];
    if (!ownerRoleId || !adminRoleId || !memberRoleId)
      throw new Error('System roles were not created');

    const principalId = generateId('principal');

    try {
      await tx.insert(principal).values({
        id: principalId,
        tenantId: resolvedTenantId,
        kind: 'user',
        refId: opts.userId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      const existingPrincipal = await tx.query.principal.findFirst({
        where: and(
          eq(principal.tenantId, resolvedTenantId),
          eq(principal.kind, 'user'),
          eq(principal.refId, opts.userId)
        ),
      });
      if (!existingPrincipal) throw err;
    }

    await tx.insert(principalRole).values({
      principalId,
      roleId: ownerRoleId,
      createdAt: now,
    });

    // Match Interchange's default role grant seeding from createTenantRoutes
    await tx.insert(grant).values({
      id: generateId('grant'),
      tenantId: resolvedTenantId,
      roleId: ownerRoleId,
      resource: '*',
      action: '*',
      effect: 'allow',
      origin: 'system',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(grant).values({
      id: generateId('grant'),
      tenantId: resolvedTenantId,
      roleId: adminRoleId,
      resource: '*',
      action: 'read',
      effect: 'allow',
      origin: 'system',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(grant).values({
      id: generateId('grant'),
      tenantId: resolvedTenantId,
      roleId: adminRoleId,
      resource: '*',
      action: 'create',
      effect: 'allow',
      origin: 'system',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(grant).values({
      id: generateId('grant'),
      tenantId: resolvedTenantId,
      roleId: adminRoleId,
      resource: '*',
      action: 'manage',
      effect: 'allow',
      origin: 'system',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(grant).values({
      id: generateId('grant'),
      tenantId: resolvedTenantId,
      roleId: memberRoleId,
      resource: '*',
      action: 'read',
      effect: 'allow',
      origin: 'system',
      createdAt: now,
      updatedAt: now,
    });

    log.info('Personal tenant provisioned', { userId: opts.userId, tenantId: resolvedTenantId });
    return { tenantId: resolvedTenantId };
  });
}

/**
 * Ensure the shared GTM Workbench tenant exists. Safe to call at every boot.
 */
export async function ensureWorkbenchTenant(
  db: ProductionDB,
  slug: string
): Promise<WorkbenchTenantResult> {
  const existing = await db.query.tenant.findFirst({
    where: eq(tenant.slug, slug),
  });
  if (existing) {
    log.info('Workbench tenant already exists', { tenantId: existing.id });
    return { tenantId: existing.id };
  }

  return db.transaction(async (tx) => {
    const tenantId = generateId('tenant');
    const domain = `${slug}.localhost`;
    const now = new Date();

    let resolvedTenantId: string;

    try {
      const tenantRows = await tx
        .insert(tenant)
        .values({
          id: tenantId,
          name: 'GTM Workbench',
          slug,
          domain,
          parentId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const tenantRow = tenantRows[0];
      if (!tenantRow) throw new Error('Failed to create workbench tenant');
      resolvedTenantId = (tenantRow as { id: string }).id;
    } catch (err) {
      const existingOnConflict = await tx.query.tenant.findFirst({
        where: eq(tenant.slug, slug),
      });
      if (existingOnConflict) return { tenantId: existingOnConflict.id };
      throw err;
    }

    const roleIds: Record<string, string> = {};
    for (const roleName of SYSTEM_ROLES) {
      const roleId = generateId('role');
      roleIds[roleName] = roleId;
      await tx.insert(role).values({
        id: roleId,
        tenantId: resolvedTenantId,
        name: roleName,
        description: `System ${roleName} role`,
        isSystem: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    const ownerRoleId = roleIds['owner'];
    const adminRoleId = roleIds['admin'];
    const memberRoleId = roleIds['member'];
    if (!ownerRoleId || !adminRoleId || !memberRoleId)
      throw new Error('System roles were not created');

    // Match Interchange's default role grant seeding from createTenantRoutes
    await tx.insert(grant).values({
      id: generateId('grant'),
      tenantId: resolvedTenantId,
      roleId: ownerRoleId,
      resource: '*',
      action: '*',
      effect: 'allow',
      origin: 'system',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(grant).values({
      id: generateId('grant'),
      tenantId: resolvedTenantId,
      roleId: adminRoleId,
      resource: '*',
      action: 'read',
      effect: 'allow',
      origin: 'system',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(grant).values({
      id: generateId('grant'),
      tenantId: resolvedTenantId,
      roleId: adminRoleId,
      resource: '*',
      action: 'create',
      effect: 'allow',
      origin: 'system',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(grant).values({
      id: generateId('grant'),
      tenantId: resolvedTenantId,
      roleId: adminRoleId,
      resource: '*',
      action: 'manage',
      effect: 'allow',
      origin: 'system',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(grant).values({
      id: generateId('grant'),
      tenantId: resolvedTenantId,
      roleId: memberRoleId,
      resource: '*',
      action: 'read',
      effect: 'allow',
      origin: 'system',
      createdAt: now,
      updatedAt: now,
    });

    log.info('Workbench tenant provisioned', { tenantId: resolvedTenantId });
    return { tenantId: resolvedTenantId };
  });
}

/**
 * Ensure the user has a principal in the shared GTM Workbench tenant with
 * the member role. Idempotent.
 */
export async function ensureWorkbenchPrincipal(
  db: ProductionDB,
  opts: { userId: string; workbenchTenantId: string }
): Promise<WorkbenchPrincipalResult> {
  const existing = await db.query.principal.findFirst({
    where: and(
      eq(principal.tenantId, opts.workbenchTenantId),
      eq(principal.kind, 'user'),
      eq(principal.refId, opts.userId)
    ),
  });
  if (existing) {
    log.info('Workbench principal already exists', {
      userId: opts.userId,
      principalId: existing.id,
    });
    return { principalId: existing.id };
  }

  const memberRole = await db.query.role.findFirst({
    where: and(eq(role.tenantId, opts.workbenchTenantId), eq(role.name, 'member')),
  });
  if (!memberRole) {
    throw new Error(
      `Member role not found on workbench tenant ${opts.workbenchTenantId}. Was the tenant bootstrapped?`
    );
  }

  const principalId = generateId('principal');
  const now = new Date();

  try {
    await db.insert(principal).values({
      id: principalId,
      tenantId: opts.workbenchTenantId,
      kind: 'user',
      refId: opts.userId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    const existingOnConflict = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, opts.workbenchTenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, opts.userId)
      ),
    });
    if (existingOnConflict) return { principalId: existingOnConflict.id };
    throw err;
  }

  await db.insert(principalRole).values({
    principalId,
    roleId: memberRole.id,
    createdAt: now,
  });

  log.info('Workbench principal provisioned', { userId: opts.userId, principalId });
  return { principalId };
}

/**
 * Seed a cross-tenant deliver grant on the personal tenant's owner role,
 * targeting the workbench tenant. Idempotent.
 *
 * Uses the owner role because personal tenant users hold the owner role
 * (per AUTH.md), and source:"invoker" grants require the invoker to hold the
 * grant being delegated.
 */
export async function seedDeliverGrant(
  db: ProductionDB,
  opts: { personalTenantId: string; workbenchTenantId: string }
): Promise<void> {
  const ownerRole = await db.query.role.findFirst({
    where: and(eq(role.tenantId, opts.personalTenantId), eq(role.name, 'owner')),
  });
  if (!ownerRole) {
    throw new Error(
      `Owner role not found on personal tenant ${opts.personalTenantId}. Was the tenant bootstrapped?`
    );
  }

  const resource = `tenant:${opts.workbenchTenantId}`;
  const existing = await db.query.grant.findFirst({
    where: and(
      eq(grant.tenantId, opts.personalTenantId),
      eq(grant.roleId, ownerRole.id),
      eq(grant.resource, resource),
      eq(grant.action, 'deliver')
    ),
  });
  if (existing) {
    log.info('Deliver grant already present', { personalTenantId: opts.personalTenantId });
    return;
  }

  const now = new Date();
  await db.insert(grant).values({
    id: generateId('grant'),
    tenantId: opts.personalTenantId,
    roleId: ownerRole.id,
    resource,
    action: 'deliver',
    effect: 'allow',
    origin: 'system',
    createdAt: now,
    updatedAt: now,
  });

  log.info('Deliver grant seeded', {
    personalTenantId: opts.personalTenantId,
    workbenchTenantId: opts.workbenchTenantId,
  });
}

/**
 * Fully provision a new user: personal tenant + workbench membership +
 * cross-tenant deliver grant. Returns all provisioned IDs.
 *
 * Non-throwing — errors are logged and rethrown so the caller can decide
 * whether to surface them or swallow them (signup should not be blocked).
 */
export async function provisionUserOnSignup(
  db: ProductionDB,
  opts: { userId: string; userEmail: string; workbenchTenantId: string }
): Promise<{ personalTenantId: string; workbenchPrincipalId: string }> {
  const { tenantId: personalTenantId } = await provisionPersonalTenant(db, {
    userId: opts.userId,
    userEmail: opts.userEmail,
  });

  const { principalId: workbenchPrincipalId } = await ensureWorkbenchPrincipal(db, {
    userId: opts.userId,
    workbenchTenantId: opts.workbenchTenantId,
  });

  await seedDeliverGrant(db, {
    personalTenantId,
    workbenchTenantId: opts.workbenchTenantId,
  });

  return { personalTenantId, workbenchPrincipalId };
}
