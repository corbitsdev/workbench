import { eq, and } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { generateId } from '@intx/hub-common';
import {
  GRANOLA_DEPLOY_PROMPT,
  GRANOLA_CREDENTIAL_REQUIREMENTS,
  GRANOLA_CAPABILITIES,
} from '@workbench/agents/granola-definition';
import { LOOP_CREDENTIAL_REQUIREMENTS } from '@workbench/agents';

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

type WorkbenchTenantResult = { tenantId: string; principalId: string };

/**
 * Provision a named workbench tenant for a user and assign them as the owner.
 * Idempotent by slug — if the tenant exists and the user is already a principal,
 * returns it with `alreadyExists: true`. If the tenant exists but the user is not
 * a principal, throws a conflict error so the caller can return 409.
 *
 * Role and grant seeding mirrors `provisionPersonalTenant` — the same three system
 * roles (owner / admin / member) with the same default grants.
 */
export async function provisionWorkbenchTenant(
  db: ProductionDB,
  opts: { userId: string; name: string; slug: string }
): Promise<WorkbenchTenantResult & { alreadyExists: boolean }> {
  const existing = await db.query.tenant.findFirst({
    where: eq(tenant.slug, opts.slug),
  });

  if (existing) {
    const existingPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, existing.id),
        eq(principal.kind, 'user'),
        eq(principal.refId, opts.userId)
      ),
    });
    if (existingPrincipal) {
      return { tenantId: existing.id, principalId: existingPrincipal.id, alreadyExists: true };
    }
    throw Object.assign(new Error('Workbench slug conflict'), { code: 'SLUG_CONFLICT' });
  }

  const result = await db.transaction(async (tx) => {
    const tenantId = generateId('tenant');
    const domain = `${opts.slug}.localhost`;
    const now = new Date();

    const tenantRows = await tx
      .insert(tenant)
      .values({
        id: tenantId,
        name: opts.name,
        slug: opts.slug,
        domain,
        parentId: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const tenantRow = tenantRows[0];
    if (!tenantRow) throw new Error('Failed to insert workbench tenant');
    const resolvedTenantId = (tenantRow as { id: string }).id;

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
    if (!ownerRoleId || !adminRoleId || !memberRoleId) {
      throw new Error('System roles were not created');
    }

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

    for (const action of ['read', 'create', 'manage'] as const) {
      await tx.insert(grant).values({
        id: generateId('grant'),
        tenantId: resolvedTenantId,
        roleId: adminRoleId,
        resource: '*',
        action,
        effect: 'allow',
        origin: 'system',
        createdAt: now,
        updatedAt: now,
      });
    }

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

    const principalId = generateId('principal');
    await tx.insert(principal).values({
      id: principalId,
      tenantId: resolvedTenantId,
      kind: 'user',
      refId: opts.userId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(principalRole).values({
      principalId,
      roleId: ownerRoleId,
      createdAt: now,
    });

    log.info('Workbench tenant provisioned', {
      userId: opts.userId,
      tenantId: resolvedTenantId,
      slug: opts.slug,
    });
    return { tenantId: resolvedTenantId, principalId };
  });

  return { ...result, alreadyExists: false };
}

export const PERSONAL_AGENT_DEPLOY_PROMPT =
  'You are Myra, a personal GTM assistant. You help the user turn customer conversations into polished sales and marketing collateral. Be concise, direct, and professional.';

type PersonalTenantResult = { tenantId: string; principalId: string };
type MyraInstanceResult = { paInstanceId: string };
type OatInstanceResult = { oatInstanceId: string };

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

  return db.transaction(async (tx) => {
    if (!existingAgent) {
      const agentRows = await tx
        .insert(agent)
        .values({
          id: agentId,
          tenantId: opts.personalTenantId,
          creatorPrincipalId: opts.creatorPrincipalId,
          name: 'Myra',
          systemPrompt: PERSONAL_AGENT_DEPLOY_PROMPT,
          credentialRequirements: LOOP_CREDENTIAL_REQUIREMENTS,
          capabilities: null,
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
    await tx.insert(principal).values({
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

    await tx.insert(agentInstance).values({
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
  });
}

/**
 * Ensure an Oat agent and running instance exist on the workbench tenant.
 * Oat is a workbench-scoped Granola integration agent — one instance per workbench.
 * Idempotent — if both already exist, returns the existing instance ID.
 */
export async function provisionOatInstance(
  db: ProductionDB,
  opts: {
    workbenchTenantId: string;
    workbenchTenantDomain: string;
    creatorPrincipalId: string;
  }
): Promise<OatInstanceResult> {
  const existingAgent = await db.query.agent.findFirst({
    where: and(eq(agent.tenantId, opts.workbenchTenantId), eq(agent.name, 'Oat')),
  });

  if (existingAgent) {
    const existingInstance = await db.query.agentInstance.findFirst({
      where: eq(agentInstance.agentId, existingAgent.id),
    });
    if (existingInstance) {
      log.info('Oat instance already exists', {
        tenantId: opts.workbenchTenantId,
        instanceId: existingInstance.id,
      });
      return { oatInstanceId: existingInstance.id };
    }
  }

  const now = new Date();
  const agentId = existingAgent?.id ?? generateId('agent');

  return db.transaction(async (tx) => {
    if (!existingAgent) {
      const agentRows = await tx
        .insert(agent)
        .values({
          id: agentId,
          tenantId: opts.workbenchTenantId,
          creatorPrincipalId: opts.creatorPrincipalId,
          name: 'Oat',
          systemPrompt: GRANOLA_DEPLOY_PROMPT,
          capabilities: GRANOLA_CAPABILITIES,
          credentialRequirements: GRANOLA_CREDENTIAL_REQUIREMENTS,
          status: 'deployed',
          currentVersion: '1',
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const agentRow = agentRows?.[0];
      if (!agentRow) throw new Error('Failed to create Oat agent for workbench');
    }

    const instancePrincipalId = generateId('principal');
    await tx.insert(principal).values({
      id: instancePrincipalId,
      tenantId: opts.workbenchTenantId,
      kind: 'agent',
      refId: agentId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    const instanceId = generateId('instance');
    const address = `${instanceId}@${opts.workbenchTenantDomain}`;

    await tx.insert(agentInstance).values({
      id: instanceId,
      agentId,
      tenantId: opts.workbenchTenantId,
      principalId: instancePrincipalId,
      address,
      status: 'deployed',
      createdAt: now,
      updatedAt: now,
    });

    log.info('Oat instance provisioned', {
      tenantId: opts.workbenchTenantId,
      instanceId,
    });
    return { oatInstanceId: instanceId };
  });
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
