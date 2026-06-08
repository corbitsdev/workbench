import { eq, and } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { generateId } from '@intx/hub-common';
import {
  PERSONAL_AGENT_DEPLOY_PROMPT,
  PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
  PERSONAL_AGENT_BASE_TOOLS,
} from '@workbench/agents';
import { getConfig } from '../config';

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

/**
 * Seed the single shared global org tenant at hub boot. Idempotent and race-safe
 * across replicas: relies on the unique `slug` constraint and a
 * catch-unique-violation-and-reselect.
 *
 * Name / slug / domain come from config (env), never hardcoded — the same code
 * produces a different org for a different deployment.
 *
 * Grant set is deliberately corrected from the personal-tenant seeding: the
 * `member` role gets NO grants. Product reads are principal-scoped and never
 * consult the Interchange grant system, so a member `*:read` grant only creates
 * risk in a shared tenant. Membership is the principal row existing. Owner
 * (`*:*`) and admin (`*:{read,create,manage}`) grants are kept for org admins.
 *
 * Does not seed Myra's LLM credential — that real secret flows through the
 * credential-creation path, not code.
 */
export async function seedGlobalTenant(db: ProductionDB): Promise<{ tenantId: string }> {
  const { slug, name, domain } = getConfig().globalTenant;

  const existing = await db.query.tenant.findFirst({
    where: eq(tenant.slug, slug),
  });
  if (existing) {
    // Fail loud if the tenant exists but is missing its system roles (e.g. a
    // partial seed or a tenant created by a different path with the same slug):
    // ensureGlobalMember would otherwise throw "Member role missing" on every
    // signup at runtime. The boot contract is fail-loud, so surface it here.
    const memberRole = await db.query.role.findFirst({
      where: and(eq(role.tenantId, existing.id), eq(role.name, 'member')),
    });
    if (!memberRole) {
      throw new Error(
        `Global tenant ${existing.id} (slug=${slug}) exists but is missing its system roles — refusing to start`
      );
    }
    log.info('Global tenant already exists', { tenantId: existing.id, slug });
    return { tenantId: existing.id };
  }

  try {
    return await db.transaction(async (tx) => {
      const tenantId = generateId('tenant');
      const now = new Date();

      const tenantRows = await tx
        .insert(tenant)
        .values({
          id: tenantId,
          name,
          slug,
          domain,
          parentId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const tenantRow = tenantRows[0];
      if (!tenantRow) throw new Error('Failed to insert global tenant');
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
      if (!ownerRoleId || !adminRoleId) throw new Error('System roles were not created');

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

      // Intentionally no member grant — see the doc comment above.

      log.info('Global tenant seeded', { tenantId: resolvedTenantId, slug });
      return { tenantId: resolvedTenantId };
    });
  } catch (err) {
    // A concurrent replica may have created the tenant between our pre-check and
    // insert. The unique slug constraint makes that insert throw; reselect it.
    const existingOnConflict = await db.query.tenant.findFirst({
      where: eq(tenant.slug, slug),
    });
    if (existingOnConflict) {
      log.info('Global tenant created concurrently, reselected', {
        tenantId: existingOnConflict.id,
        slug,
      });
      return { tenantId: existingOnConflict.id };
    }
    throw err;
  }
}

/**
 * Add a same-domain user to the shared global org tenant as a `member`
 * principal. Idempotent and race-safe (two tabs / signup+first-session can
 * race): relies on the unique `principal (tenantId, kind, refId)` constraint and
 * catches the unique violation to reselect on a fresh connection.
 *
 * Membership is purely the principal row existing plus the member role — no
 * `*:read` grant (see `seedGlobalTenant`). Throws if the global tenant has not
 * been seeded yet, since there is nothing to join.
 */
export async function ensureGlobalMember(
  db: ProductionDB,
  opts: { userId: string }
): Promise<{ tenantId: string; principalId: string }> {
  const { slug } = getConfig().globalTenant;

  const globalTenant = await db.query.tenant.findFirst({
    where: eq(tenant.slug, slug),
  });
  if (!globalTenant) {
    throw new Error(`Global tenant (slug=${slug}) not seeded — cannot add member`);
  }

  const reselect = () =>
    db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, globalTenant.id),
        eq(principal.kind, 'user'),
        eq(principal.refId, opts.userId)
      ),
    });

  const existing = await reselect();
  if (existing) {
    log.info('Global member already exists', { userId: opts.userId, principalId: existing.id });
    return { tenantId: globalTenant.id, principalId: existing.id };
  }

  const memberRole = await db.query.role.findFirst({
    where: and(eq(role.tenantId, globalTenant.id), eq(role.name, 'member')),
  });
  if (!memberRole) {
    throw new Error(`Member role missing on global tenant ${globalTenant.id}`);
  }

  try {
    return await db.transaction(async (tx) => {
      const now = new Date();
      const principalId = generateId('principal');

      await tx.insert(principal).values({
        id: principalId,
        tenantId: globalTenant.id,
        kind: 'user',
        refId: opts.userId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(principalRole).values({
        principalId,
        roleId: memberRole.id,
        createdAt: now,
      });

      log.info('Global member provisioned', { userId: opts.userId, principalId });
      return { tenantId: globalTenant.id, principalId };
    });
  } catch (err) {
    // A concurrent join created the principal between our pre-check and insert.
    // The unique (tenantId, kind, refId) constraint aborts our transaction; the
    // reselect MUST run on a fresh connection (db, not the aborted tx), so it is
    // outside the transaction. The concurrent writer also assigns the role.
    const existingOnConflict = await reselect();
    if (existingOnConflict) {
      log.info('Global member created concurrently, reselected', {
        userId: opts.userId,
        principalId: existingOnConflict.id,
      });
      return { tenantId: globalTenant.id, principalId: existingOnConflict.id };
    }
    throw err;
  }
}

type WorkbenchTenantResult = { tenantId: string; principalId: string };

/**
 * Provision a named workbench tenant for a user and assign them as the owner.
 * Idempotent by slug — if the tenant exists and the user is already a principal,
 * returns it with `alreadyExists: true`. If the tenant exists but the user is not
 * a principal, throws a conflict error so the caller can return 409.
 *
 * Role and grant seeding mirrors the system-role seeding used elsewhere — the
 * same three system roles (owner / admin / member) with the same default grants.
 *
 * The workbench is created as a SUB-TENANT of the global org tenant
 * (`parentId = globalTenantId`) so the org-level LLM credential resolves down
 * the hierarchy via getAncestorChain → resolveCredentialRequirement (CL-1445).
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

  const { slug: globalSlug } = getConfig().globalTenant;
  const globalTenant = await db.query.tenant.findFirst({
    where: eq(tenant.slug, globalSlug),
  });
  if (!globalTenant) {
    throw new Error(`Global tenant (slug=${globalSlug}) not seeded — cannot create workbench`);
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
        parentId: globalTenant.id,
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

type MyraInstanceResult = { paInstanceId: string };

/**
 * Ensure a per-user Myra agent definition and instance exist in a tenant,
 * keyed on the owner principal. Idempotent — if both already exist for this
 * owner, returns the existing instance ID.
 *
 * Idempotency keys on `(tenantId, creatorPrincipalId)`, NOT `(tenantId, name)`.
 * In the shared global tenant every member has their own Myra named "Myra";
 * keying on name would hand the first user's Myra to everyone. The owner
 * principal is the user's principal in this tenant.
 *
 * The definition is derived from the shared template in `@workbench/agents`
 * (prompt + credential requirements + base toolset). Per-user tool edits later
 * mutate this user's own `capabilities.tools` only.
 */
export async function provisionMyraInstance(
  db: ProductionDB,
  opts: {
    tenantId: string;
    tenantDomain: string;
    userId: string;
    creatorPrincipalId: string;
  }
): Promise<MyraInstanceResult> {
  const existingAgent = await db.query.agent.findFirst({
    where: and(
      eq(agent.tenantId, opts.tenantId),
      eq(agent.creatorPrincipalId, opts.creatorPrincipalId)
    ),
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
  const baseCapabilities =
    PERSONAL_AGENT_BASE_TOOLS.length > 0 ? { tools: [...PERSONAL_AGENT_BASE_TOOLS] } : null;

  return db.transaction(async (tx) => {
    if (!existingAgent) {
      const agentRows = await tx
        .insert(agent)
        .values({
          id: agentId,
          tenantId: opts.tenantId,
          creatorPrincipalId: opts.creatorPrincipalId,
          name: 'Myra',
          systemPrompt: PERSONAL_AGENT_DEPLOY_PROMPT,
          credentialRequirements: PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
          capabilities: baseCapabilities,
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
      tenantId: opts.tenantId,
      kind: 'agent',
      refId: agentId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    const instanceId = generateId('instance');
    const address = `${instanceId}@${opts.tenantDomain}`;

    await tx.insert(agentInstance).values({
      id: instanceId,
      agentId,
      tenantId: opts.tenantId,
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
