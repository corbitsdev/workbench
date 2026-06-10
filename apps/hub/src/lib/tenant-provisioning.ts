import { eq, and, isNull } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import { generateId } from '@intx/hub-common';
import { AGENT_TEMPLATES, type AgentTemplate } from '@workbench/agents';
import { getConfig } from '../config';
import type { HubDb } from '../db';
import { memberAgentInstance, enabledWorkflow } from '../db/schema';

const log = getLogger(['api', 'tenant-provisioning']);

const {
  tenant,
  principal,
  role,
  principalRole,
  grant,
  agent,
  agentInstance,
  agentVersion,
  provider,
} = intxSchema;

type ProductionDB = DB['db'];

// Narrower structural type for tests only — satisfies transaction contract.
export type ProvisioningDB = {
  transaction: <T>(fn: (tx: ProvisioningDB) => Promise<T>) => Promise<T>;
  query: {
    tenant: {
      findFirst: (
        // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
        opts: any
      ) => Promise<{ id: string; slug: string; config?: unknown } | undefined>;
    };
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
    memberAgentInstance: {
      // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
      findFirst: (opts: any) => Promise<{ id: string; instanceId: string } | undefined>;
    };
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

/**
 * Stable synthetic refId for the dedicated system principal that owns every
 * seeded agent template. Distinct from any real user refId (which are user IDs),
 * so it never collides with a human member and is idempotent across boots.
 */
const SYSTEM_PRINCIPAL_REF_ID = 'system';

/**
 * Idempotently create and return the dedicated system principal in a tenant.
 * Seeded agent definitions are owned by this principal (never a human), so the
 * org's templates are not tied to any individual member.
 *
 * Keys on the unique `(tenantId, kind, refId)` constraint with a synthetic
 * `kind:'user', refId:'system'`. Race-safe across replicas: catches the unique
 * violation and reselects on a fresh connection (mirrors `ensureGlobalMember`).
 */
export async function ensureSystemPrincipal(
  db: ProductionDB,
  tenantId: string
): Promise<{ principalId: string }> {
  const reselect = () =>
    db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, SYSTEM_PRINCIPAL_REF_ID)
      ),
    });

  const existing = await reselect();
  if (existing) {
    return { principalId: existing.id };
  }

  try {
    const now = new Date();
    const principalId = generateId('principal');
    await db.insert(principal).values({
      id: principalId,
      tenantId,
      kind: 'user',
      refId: SYSTEM_PRINCIPAL_REF_ID,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    log.info('System principal provisioned', { tenantId, principalId });
    return { principalId };
  } catch (err) {
    // A concurrent replica created the system principal between our pre-check
    // and insert; the unique (tenantId, kind, refId) constraint aborts our
    // insert. Reselect on a fresh connection.
    const existingOnConflict = await reselect();
    if (existingOnConflict) {
      log.info('System principal created concurrently, reselected', {
        tenantId,
        principalId: existingOnConflict.id,
      });
      return { principalId: existingOnConflict.id };
    }
    throw err;
  }
}

/**
 * Seed each agent template (`AGENT_TEMPLATES`) as a first-class Interchange
 * agent definition in the global org tenant at hub boot. Idempotent and
 * race-safe: each definition is keyed on `(tenantId, name)` (find-by, then
 * create-if-missing); a concurrent insert is caught and the row reselected.
 *
 * Every seeded definition is owned by the dedicated system principal (decision:
 * templates are org-owned, never owned by a human member). Only STATIC grant
 * requirements are stored — dynamic per-workbench grants are computed at
 * instance launch, not baked into the definition (CL-1530).
 *
 * This is additive to the existing per-user Myra provisioning; the two coexist.
 * Throws if the global tenant has not been seeded — it must run after
 * `seedGlobalTenant`.
 */
export async function seedAgentTemplates(db: ProductionDB): Promise<void> {
  const { slug } = getConfig().globalTenant;

  const globalTenant = await db.query.tenant.findFirst({
    where: eq(tenant.slug, slug),
  });
  if (!globalTenant) {
    throw new Error(`Global tenant (slug=${slug}) not seeded — cannot seed agent templates`);
  }

  const { principalId: systemPrincipalId } = await ensureSystemPrincipal(db, globalTenant.id);

  for (const template of AGENT_TEMPLATES) {
    const reselect = () =>
      db.query.agent.findFirst({
        where: and(eq(agent.tenantId, globalTenant.id), eq(agent.name, template.name)),
      });

    const existing = await reselect();
    if (existing) {
      await db
        .update(agent)
        .set({
          systemPrompt: template.systemPrompt,
          credentialRequirements: template.credentialRequirements,
          grantRequirements: template.grantRequirements,
          capabilities: template.capabilities,
          updatedAt: new Date(),
        })
        .where(eq(agent.id, existing.id));
      log.info('Agent template updated', {
        tenantId: globalTenant.id,
        name: template.name,
        agentId: existing.id,
      });
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        const now = new Date();
        const agentId = generateId('agent');

        const agentRows = await tx
          .insert(agent)
          .values({
            id: agentId,
            tenantId: globalTenant.id,
            creatorPrincipalId: systemPrincipalId,
            name: template.name,
            systemPrompt: template.systemPrompt,
            credentialRequirements: template.credentialRequirements,
            grantRequirements: template.grantRequirements,
            capabilities: template.capabilities,
            modelConfig: template.modelConfig ?? null,
            status: 'deployed',
            currentVersion: '1',
            createdAt: now,
            updatedAt: now,
          })
          .returning?.();

        if (!agentRows?.[0]) {
          throw new Error(`Failed to seed agent template ${template.name}`);
        }

        await tx.insert(agentVersion).values({
          id: generateId('agentVersion'),
          agentId,
          version: '1',
          status: 'active',
          createdAt: now,
        });

        log.info('Agent template seeded', {
          tenantId: globalTenant.id,
          name: template.name,
          agentId,
          key: template.key,
        });
      });
    } catch (err) {
      // A concurrent replica may have seeded this template between our pre-check
      // and insert; reselect by (tenantId, name) on a fresh connection.
      const existingOnConflict = await reselect();
      if (existingOnConflict) {
        log.info('Agent template seeded concurrently, reselected', {
          tenantId: globalTenant.id,
          name: template.name,
          agentId: existingOnConflict.id,
        });
        continue;
      }
      throw err;
    }
  }

  // After seeding definitions, patch modelConfig for any that are still null
  // but have a matching provider already configured on the tenant. This makes
  // the hub self-healing: once an admin seeds credentials, the next boot picks
  // up defaultModel without requiring a separate patching script.
  await patchMissingModelConfigs(db, globalTenant.id);
}

/**
 * For every agent definition on the tenant that has no modelConfig, scan its
 * LLM credential requirements and try to resolve a model name from the matching
 * provider's metadata. If found, writes `{ defaultModel }` so that
 * `resolveInstanceSources` can build inference sources without the agent
 * definition being manually patched by a seed script.
 */
async function patchMissingModelConfigs(db: ProductionDB, tenantId: string): Promise<void> {
  const agents = await db.query.agent.findMany({
    where: and(eq(agent.tenantId, tenantId), isNull(agent.modelConfig)),
  });
  if (agents.length === 0) return;

  for (const a of agents) {
    const reqs = (a.credentialRequirements ?? []) as Array<{
      providerName: string;
      source: string;
    }>;
    for (const req of reqs) {
      if (req.source !== 'tenant') continue;
      const providerRow = await db.query.provider.findFirst({
        where: and(eq(provider.tenantId, tenantId), eq(provider.name, req.providerName)),
      });
      const model = (providerRow?.metadata as { model?: string } | null)?.model;
      if (!model) continue;
      await db
        .update(agent)
        .set({ modelConfig: { defaultModel: model }, updatedAt: new Date() })
        .where(eq(agent.id, a.id));
      log.info('Patched modelConfig for agent template', { agentId: a.id, name: a.name, model });
      break;
    }
  }
}

/**
 * jsonb key on the global tenant's `config` column holding the admin-controlled
 * list of agent template keys enabled for the org. Stored on the tenant row
 * (not a per-template table) so enablement is a single generic config edit.
 */
const ENABLED_AGENT_TEMPLATES_CONFIG_KEY = 'enabledAgentTemplates';

/**
 * Default enablement when the global tenant's config is unset, empty, or has no
 * `enabledAgentTemplates` entry. Every member gets Myra on join; other templates
 * are opt-in by an admin (CL-1531).
 */
const DEFAULT_ENABLED_TEMPLATE_KEYS = ['myra'] as const;

/**
 * Resolve the agent templates enabled for the org, in `AGENT_TEMPLATES` order.
 *
 * Reads the global tenant's `config` jsonb → `enabledAgentTemplates` (a
 * `string[]` of template keys). Falls back to `['myra']` when unset, empty, not
 * an array, or missing — Myra is always enabled for new members. Unknown keys
 * (no matching `AGENT_TEMPLATES` entry) are dropped with a warning.
 *
 * Returns the resolved `AgentTemplate[]`. CL-1532's join path iterates this list
 * to create one per-user agent instance per enabled template.
 */
export async function getEnabledTemplateKeys(db: ProductionDB): Promise<AgentTemplate[]> {
  const { slug } = getConfig().globalTenant;

  const globalTenant = await db.query.tenant.findFirst({
    where: eq(tenant.slug, slug),
  });
  if (!globalTenant) {
    throw new Error(`Global tenant (slug=${slug}) not seeded — cannot resolve enabled templates`);
  }

  const config = (globalTenant as { config?: unknown }).config;
  const rawKeys =
    config && typeof config === 'object'
      ? (config as Record<string, unknown>)[ENABLED_AGENT_TEMPLATES_CONFIG_KEY]
      : undefined;

  const configuredKeys =
    Array.isArray(rawKeys) && rawKeys.length > 0
      ? rawKeys.filter((k): k is string => typeof k === 'string')
      : [...DEFAULT_ENABLED_TEMPLATE_KEYS];

  const resolved: AgentTemplate[] = [];
  const droppedKeys: string[] = [];
  for (const key of configuredKeys) {
    const template = AGENT_TEMPLATES.find((t) => t.key === key);
    if (template) {
      resolved.push(template);
    } else {
      droppedKeys.push(key);
    }
  }

  if (droppedKeys.length > 0) {
    log.warn('Dropping unknown enabled agent template keys', {
      tenantId: globalTenant.id,
      droppedKeys,
    });
  }

  return resolved;
}

/**
 * Seed tenant-scoped (principalId IS NULL) enabledWorkflow rows for each
 * workflow kind in `kinds`. These rows make every workflow available to all
 * members of the tenant without any per-user action.
 *
 * Idempotent: uses ON CONFLICT DO NOTHING against the partial unique index on
 * (tenant_id, kind) WHERE principal_id IS NULL (migration 0017).
 *
 * Call this after seedGlobalTenant (for the org tenant) and inside
 * provisionWorkbenchTenant (for per-workbench tenants). Pass the registered
 * workflow kinds from the route layer where the registry is populated.
 */
export async function seedTenantWorkflows(
  db: ProductionDB,
  tenantId: string,
  workflowKinds: string[]
): Promise<void> {
  if (workflowKinds.length === 0) return;
  const now = new Date();
  for (const kind of workflowKinds) {
    const id = generateId('instance'); // reuse prefix; no dedicated workflow id prefix
    await db
      .insert(enabledWorkflow)
      .values({ id, tenantId, principalId: null, kind, assignments: {}, enabledAt: now })
      .onConflictDoNothing();
    log.info('Tenant workflow ensured', { tenantId, kind });
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
  opts: { userId: string; name: string; slug: string; workflowKinds?: string[] }
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

  if (opts.workflowKinds && opts.workflowKinds.length > 0) {
    await seedTenantWorkflows(db, result.tenantId, opts.workflowKinds);
  }

  return { ...result, alreadyExists: false };
}

/** The Myra template key — the always-enabled personal agent. */
export const MYRA_TEMPLATE_KEY = 'myra';

export type MemberInstance = { templateKey: string; instanceId: string };

/**
 * Create, for a joining member, one per-user agent INSTANCE of each enabled
 * org-level template definition (CL-1532). The shared definitions are seeded
 * once at boot by `seedAgentTemplates` (CL-1530) and owned by the system
 * principal; members never get their own definitions — only instances that
 * reference the shared one, so systemPrompt / credentialRequirements /
 * capabilities all come from the org definition.
 *
 * Enabled templates come from `getEnabledTemplateKeys` (CL-1531), defaulting to
 * `['myra']`. Per-user attribution is recorded in the workbench
 * `member_agent_instance` table, keyed `(tenantId, memberPrincipalId,
 * templateKey)` — Interchange's `agent_instance` has no owner-user column.
 *
 * Idempotent and race-safe per template: if a mapping row already exists AND its
 * instance still exists, the template is skipped. A missing shared definition is
 * logged and skipped (never throws the whole join). A unique-violation on the
 * mapping insert (concurrent join) is caught and the row reselected.
 *
 * Returns one entry per enabled template (created or pre-existing).
 */
export async function provisionMemberInstances(
  db: HubDb,
  opts: { userId: string; memberPrincipalId: string }
): Promise<MemberInstance[]> {
  const { slug, domain } = getConfig().globalTenant;

  const globalTenant = await db.query.tenant.findFirst({
    where: eq(tenant.slug, slug),
  });
  if (!globalTenant) {
    throw new Error(`Global tenant (slug=${slug}) not seeded — cannot provision member instances`);
  }
  const tenantId = globalTenant.id;

  const templates = await getEnabledTemplateKeys(db);

  const results: MemberInstance[] = [];

  for (const template of templates) {
    // The shared org definition seeded by CL-1530, keyed on (tenantId, name).
    const def = await db.query.agent.findFirst({
      where: and(eq(agent.tenantId, tenantId), eq(agent.name, template.name)),
    });
    if (!def) {
      log.warn('Enabled template has no seeded org definition — skipping member instance', {
        userId: opts.userId,
        templateKey: template.key,
        name: template.name,
      });
      continue;
    }
    const agentId = def.id;

    const reselectMapping = () =>
      db.query.memberAgentInstance.findFirst({
        where: and(
          eq(memberAgentInstance.tenantId, tenantId),
          eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
          eq(memberAgentInstance.templateKey, template.key)
        ),
      });

    const existingMapping = await reselectMapping();
    if (existingMapping) {
      const existingInstance = await db.query.agentInstance.findFirst({
        where: eq(agentInstance.id, existingMapping.instanceId),
      });
      if (existingInstance) {
        results.push({ templateKey: template.key, instanceId: existingMapping.instanceId });
        continue;
      }
      // Mapping exists but its instance is gone — recreate the instance below.
    }

    try {
      const created = await db.transaction(async (tx) => {
        const now = new Date();

        const instanceId = generateId('instance');
        const instancePrincipalId = generateId('principal');
        await tx.insert(principal).values({
          id: instancePrincipalId,
          tenantId,
          kind: 'agent',
          refId: instanceId,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(agentInstance).values({
          id: instanceId,
          agentId,
          tenantId,
          principalId: instancePrincipalId,
          address: `${instanceId}@${domain}`,
          status: 'deployed',
          createdAt: now,
          updatedAt: now,
        });

        await tx.insert(memberAgentInstance).values({
          id: generateId('instance'),
          tenantId,
          memberPrincipalId: opts.memberPrincipalId,
          templateKey: template.key,
          agentId,
          instanceId,
          createdAt: now,
        });

        log.info('Member agent instance provisioned', {
          userId: opts.userId,
          templateKey: template.key,
          agentId,
          instanceId,
        });
        return { templateKey: template.key, instanceId };
      });
      results.push(created);
    } catch (err) {
      // A concurrent join created the mapping between our pre-check and insert;
      // the (tenant, member, template) unique constraint aborts our transaction.
      // Reselect on a fresh connection.
      const racedMapping = await reselectMapping();
      if (racedMapping) {
        log.info('Member agent instance created concurrently, reselected', {
          userId: opts.userId,
          templateKey: template.key,
          instanceId: racedMapping.instanceId,
        });
        results.push({ templateKey: template.key, instanceId: racedMapping.instanceId });
        continue;
      }
      throw err;
    }
  }

  return results;
}

/**
 * The member's Myra instance id from a `provisionMemberInstances` result — the
 * value `/me` returns as `paInstanceId`. Returns null if Myra was not among the
 * enabled templates (it always is by default), so the caller can degrade.
 */
export function getMyraInstanceId(instances: MemberInstance[]): string | null {
  return instances.find((i) => i.templateKey === MYRA_TEMPLATE_KEY)?.instanceId ?? null;
}
