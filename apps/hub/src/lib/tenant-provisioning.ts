import { eq, and } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { generateId } from '@intx/hub-common';

const log = getLogger(['api', 'tenant-provisioning']);

const { tenant, principal, role, principalRole, grant, agent, agentInstance } = intxSchema;

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
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    agent: { findFirst: (opts: any) => Promise<{ id: string; name: string } | undefined> };
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    agentInstance: { findFirst: (opts: any) => Promise<{ id: string } | undefined> };
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

const PERSONAL_AGENT_DEPLOY_PROMPT =
  'You are Myra, a personal GTM assistant. You help the user turn customer conversations into polished sales and marketing collateral. Be concise, direct, and professional.';

type PersonalTenantResult = { tenantId: string; principalId: string };
type MyraInstanceResult = { paInstanceId: string };

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
    const existingPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, existing.id),
        eq(principal.kind, 'user'),
        eq(principal.refId, opts.userId)
      ),
    });
    if (!existingPrincipal)
      throw new Error(`Principal not found for existing tenant ${existing.id}`);
    return { tenantId: existing.id, principalId: existingPrincipal.id };
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
      if (existingOnConflict) {
        const existingPrincipalOnConflict = await tx.query.principal.findFirst({
          where: and(
            eq(principal.tenantId, existingOnConflict.id),
            eq(principal.kind, 'user'),
            eq(principal.refId, opts.userId)
          ),
        });
        if (!existingPrincipalOnConflict)
          throw new Error(`Principal not found for existing tenant ${existingOnConflict.id}`);
        return { tenantId: existingOnConflict.id, principalId: existingPrincipalOnConflict.id };
      }
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

    let principalId = generateId('principal');

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
      principalId = existingPrincipal.id;
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
    return { tenantId: resolvedTenantId, principalId };
  });
}

/**
 * Ensure a Myra agent and running instance exist in the user's personal tenant.
 * Idempotent — if both already exist, returns the existing instance ID.
 */
export async function provisionMyraInstance(
  db: ProductionDB,
  opts: {
    personalTenantId: string;
    personalTenantDomain: string;
    userId: string;
    creatorPrincipalId: string;
  }
): Promise<MyraInstanceResult> {
  const existingAgent = await db.query.agent.findFirst({
    where: and(eq(agent.tenantId, opts.personalTenantId), eq(agent.name, 'Myra')),
  });

  if (existingAgent) {
    const existingInstance = await db.query.agentInstance.findFirst({
      where: eq(agentInstance.agentId, existingAgent.id),
    });
    if (existingInstance) {
      log.info('Myra instance already exists', {
        userId: opts.userId,
        instanceId: existingInstance.id,
      });
      return { paInstanceId: existingInstance.id };
    }
  }

  const now = new Date();
  const agentId = existingAgent?.id ?? generateId('agent');

  if (!existingAgent) {
    const agentRows = await db
      .insert(agent)
      .values({
        id: agentId,
        tenantId: opts.personalTenantId,
        creatorPrincipalId: opts.creatorPrincipalId,
        name: 'Myra',
        systemPrompt: PERSONAL_AGENT_DEPLOY_PROMPT,
        status: 'deployed',
        currentVersion: '1',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const agentRow = agentRows?.[0];
    if (!agentRow) throw new Error(`Failed to create Myra agent for user ${opts.userId}`);
  }

  const instancePrincipalId = generateId('principal');
  await db.insert(principal).values({
    id: instancePrincipalId,
    tenantId: opts.personalTenantId,
    kind: 'agent',
    refId: agentId,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  const instanceId = generateId('instance');
  const address = `${instanceId}@${opts.personalTenantDomain}`;

  await db.insert(agentInstance).values({
    id: instanceId,
    agentId,
    tenantId: opts.personalTenantId,
    principalId: instancePrincipalId,
    address,
    status: 'deployed',
    createdAt: now,
    updatedAt: now,
  });

  log.info('Myra instance provisioned', { userId: opts.userId, instanceId });
  return { paInstanceId: instanceId };
}

/**
 * Provision a new user on signup: creates their personal Interchange tenant,
 * assigns them the owner role, and starts their Myra agent instance.
 * Workbench tenants are created separately by the user via the "+ New Workbench" flow.
 */
export async function provisionUserOnSignup(
  db: ProductionDB,
  opts: { userId: string; userEmail: string }
): Promise<{ personalTenantId: string; paInstanceId: string }> {
  const { tenantId: personalTenantId, principalId: creatorPrincipalId } =
    await provisionPersonalTenant(db, {
      userId: opts.userId,
      userEmail: opts.userEmail,
    });

  const domain = `user-${opts.userId}.localhost`;
  const { paInstanceId } = await provisionMyraInstance(db, {
    personalTenantId,
    personalTenantDomain: domain,
    userId: opts.userId,
    creatorPrincipalId,
  });

  return { personalTenantId, paInstanceId };
}
