import { eq, and } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import { generateId } from "@intx/hub-common";
import {
  AGENT_TEMPLATES,
  templateModelRequirements,
  type AgentTemplate,
} from "@workbench/agents";
import { getConfig } from "../config";
import type { HubDb } from "../db";
import { memberAgentInstance, enabledWorkflow } from "../db/schema";
import { refreshInstanceGrantsFromDefinition } from "../services/grant-reconcile";

const log = getLogger(["api", "tenant-provisioning"]);

const { tenant, principal, role, grant, agent, agentInstance, agentVersion } =
  intxSchema;

type ProductionDB = DB["db"];

// Narrower structural type for tests only — satisfies transaction contract.
export type ProvisioningDB = {
  transaction: <T>(fn: (tx: ProvisioningDB) => Promise<T>) => Promise<T>;
  query: {
    tenant: {
      findFirst: (
        // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
        opts: any,
      ) => Promise<{ id: string; slug: string; config?: unknown } | undefined>;
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    principal: {
      findFirst: (opts: any) => Promise<{ id: string } | undefined>;
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    role: { findFirst: (opts: any) => Promise<{ id: string } | undefined> };
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    grant: { findFirst: (opts: any) => Promise<{ id: string } | undefined> };
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    agent: {
      findFirst: (
        opts: any,
      ) => Promise<{ id: string; name: string } | undefined>;
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
    agentInstance: {
      findFirst: (opts: any) => Promise<{ id: string } | undefined>;
    };
    memberAgentInstance: {
      // biome-ignore lint/suspicious/noExplicitAny: structural mock interface
      findFirst: (
        opts: any,
      ) => Promise<{ id: string; instanceId: string } | undefined>;
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

const SYSTEM_ROLES = ["owner", "admin", "member"] as const;

// The transaction handle passed to a `db.transaction(...)` callback.
type Tx = Parameters<Parameters<ProductionDB["transaction"]>[0]>[0];

/**
 * Seed the three system roles (owner / admin / member) and their grants for a
 * tenant, mirroring Interchange's native tenant-creation grant shape:
 *
 *   owner  → `*:*`
 *   admin  → `*:{read,create,manage}`
 *   member → no grants
 *
 * `member` deliberately gets NO grants. Product reads are principal-scoped and
 * never consult the Interchange grant system, so membership is the principal row
 * existing — not a role grant. Access to credentials/agents comes from being
 * added as a principal on the tenant, with owner/admin granted explicitly via
 * the native Roles/Grants API. Returns the created role ids by name.
 *
 * Must run inside a transaction so a partial seed never leaves a tenant with
 * roles but no grants. Shared by `seedGlobalTenant` and operator/migration
 * scripts that stand up bench tenants.
 */
export async function seedSystemRolesAndGrants(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<Record<(typeof SYSTEM_ROLES)[number], string>> {
  const roleIds = {} as Record<(typeof SYSTEM_ROLES)[number], string>;
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

  for (const action of ["read", "create", "manage"] as const) {
    await tx.insert(grant).values({
      id: generateId("grant"),
      tenantId,
      roleId: roleIds.admin,
      resource: "*",
      action,
      effect: "allow",
      origin: "system",
      createdAt: now,
      updatedAt: now,
    });
  }

  // No member grant — membership is the principal row, not a role grant.
  return roleIds;
}

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
export async function seedGlobalTenant(
  db: ProductionDB,
): Promise<{ tenantId: string }> {
  const { slug, name, domain } = getConfig().rootTenant;

  const existing = await db.query.tenant.findFirst({
    where: eq(tenant.slug, slug),
  });
  if (existing) {
    // Fail loud if the tenant exists but is missing its system roles (e.g. a
    // partial seed or a tenant created by a different path with the same slug):
    // ensureGlobalMember would otherwise throw "Member role missing" on every
    // signup at runtime. The boot contract is fail-loud, so surface it here.
    const memberRole = await db.query.role.findFirst({
      where: and(eq(role.tenantId, existing.id), eq(role.name, "member")),
    });
    if (!memberRole) {
      throw new Error(
        `Global tenant ${existing.id} (slug=${slug}) exists but is missing its system roles — refusing to start`,
      );
    }
    log.info("Global tenant already exists", { tenantId: existing.id, slug });
    return { tenantId: existing.id };
  }

  try {
    return await db.transaction(async (tx) => {
      const tenantId = generateId("tenant");
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
      if (!tenantRow) throw new Error("Failed to insert global tenant");
      const resolvedTenantId = (tenantRow as { id: string }).id;

      await seedSystemRolesAndGrants(tx, resolvedTenantId, now);

      log.info("Global tenant seeded", { tenantId: resolvedTenantId, slug });
      return { tenantId: resolvedTenantId };
    });
  } catch (err) {
    // A concurrent replica may have created the tenant between our pre-check and
    // insert. The unique slug constraint makes that insert throw; reselect it.
    const existingOnConflict = await db.query.tenant.findFirst({
      where: eq(tenant.slug, slug),
    });
    if (existingOnConflict) {
      log.info("Global tenant created concurrently, reselected", {
        tenantId: existingOnConflict.id,
        slug,
      });
      return { tenantId: existingOnConflict.id };
    }
    throw err;
  }
}

/**
 * Resolve the deployment's root tenant id from the configured slug. This is the
 * single place the slug→tenantId resolution lives for the read/provisioning
 * paths that do not already hold the boot-resolved id (route handlers). Boot
 * code should pass the id returned by `seedGlobalTenant` directly.
 *
 * Returns null when the root tenant is not seeded — callers decide whether that
 * is fatal (boot) or a soft "no membership" (read paths).
 */
export async function getRootTenantId(
  db: ProductionDB,
): Promise<string | null> {
  const { slug } = getConfig().rootTenant;
  const root = await db.query.tenant.findFirst({
    where: eq(tenant.slug, slug),
  });
  return root?.id ?? null;
}

/**
 * Add a user to a tenant as a member principal, operating on whatever tenant id
 * it is given (no privileged slug special-casing). Idempotent and race-safe
 * (two tabs / signup+first-session can race): relies on the unique
 * `principal (tenantId, kind, refId)` constraint and catches the unique
 * violation to reselect on a fresh connection.
 *
 * Membership is purely the principal row existing — NO role is assigned. The
 * `member` role carries no grants anyway (product reads are principal-scoped and
 * never consult the grant system; see `seedGlobalTenant`), so assigning it
 * authorizes nothing. Elevated access (owner/admin) is granted explicitly via
 * the native Roles/Grants API, never implicitly on join.
 */
export async function ensureMember(
  db: ProductionDB,
  opts: { tenantId: string; userId: string },
): Promise<{ tenantId: string; principalId: string }> {
  const { tenantId, userId } = opts;

  const reselect = () =>
    db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, "user"),
        eq(principal.refId, userId),
      ),
    });

  const existing = await reselect();
  if (existing) {
    log.info("Member already exists", {
      tenantId,
      userId,
      principalId: existing.id,
    });
    return { tenantId, principalId: existing.id };
  }

  try {
    const now = new Date();
    const principalId = generateId("principal");

    await db.insert(principal).values({
      id: principalId,
      tenantId,
      kind: "user",
      refId: userId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    log.info("Member provisioned", { tenantId, userId, principalId });
    return { tenantId, principalId };
  } catch (err) {
    // A concurrent join created the principal between our pre-check and insert.
    // The unique (tenantId, kind, refId) constraint aborts the insert; the
    // reselect runs on a fresh connection.
    const existingOnConflict = await reselect();
    if (existingOnConflict) {
      log.info("Member created concurrently, reselected", {
        tenantId,
        userId,
        principalId: existingOnConflict.id,
      });
      return { tenantId, principalId: existingOnConflict.id };
    }
    throw err;
  }
}

/** Read-only: returns the user's membership in the given tenant if it exists. */
export async function lookupMember(
  db: ProductionDB,
  opts: { tenantId: string; userId: string },
): Promise<{ tenantId: string; principalId: string } | null> {
  const { tenantId, userId } = opts;
  const existing = await db.query.principal.findFirst({
    where: and(
      eq(principal.tenantId, tenantId),
      eq(principal.kind, "user"),
      eq(principal.refId, userId),
    ),
  });
  if (!existing) return null;
  return { tenantId, principalId: existing.id };
}

/**
 * @deprecated Back-compat shim for the one-off global-tenant migration only,
 * which is coupled to the root tenant by design. New code must call
 * `ensureMember(db, { tenantId, userId })` with an explicit tenant.
 */
export async function ensureGlobalMember(
  db: ProductionDB,
  opts: { userId: string },
): Promise<{ tenantId: string; principalId: string }> {
  const tenantId = await getRootTenantId(db);
  if (!tenantId) {
    throw new Error("Root tenant not seeded — cannot add member");
  }
  return ensureMember(db, { tenantId, userId: opts.userId });
}

/**
 * @deprecated Back-compat shim for the one-off global-tenant migration only.
 * New code must call `lookupMember(db, { tenantId, userId })`.
 */
export async function lookupGlobalMember(
  db: ProductionDB,
  opts: { userId: string },
): Promise<{ tenantId: string; principalId: string } | null> {
  const tenantId = await getRootTenantId(db);
  if (!tenantId) return null;
  return lookupMember(db, { tenantId, userId: opts.userId });
}

/**
 * Stable synthetic refId for the dedicated system principal that owns every
 * seeded agent template. Distinct from any real user refId (which are user IDs),
 * so it never collides with a human member and is idempotent across boots.
 */
const SYSTEM_PRINCIPAL_REF_ID = "system";

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
  tenantId: string,
): Promise<{ principalId: string }> {
  const reselect = () =>
    db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, "user"),
        eq(principal.refId, SYSTEM_PRINCIPAL_REF_ID),
      ),
    });

  const existing = await reselect();
  if (existing) {
    return { principalId: existing.id };
  }

  try {
    const now = new Date();
    const principalId = generateId("principal");
    await db.insert(principal).values({
      id: principalId,
      tenantId,
      kind: "user",
      refId: SYSTEM_PRINCIPAL_REF_ID,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    log.info("System principal provisioned", { tenantId, principalId });
    return { principalId };
  } catch (err) {
    // A concurrent replica created the system principal between our pre-check
    // and insert; the unique (tenantId, kind, refId) constraint aborts our
    // insert. Reselect on a fresh connection.
    const existingOnConflict = await reselect();
    if (existingOnConflict) {
      log.info("System principal created concurrently, reselected", {
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
/**
 * Idempotent upsert of a single agent template definition into a tenant.
 * Called by the admin CLI `deploy-agent` script and by `seedAgentTemplates`.
 * Returns the agentId (existing or newly created).
 */
export async function seedAgentTemplateIntoTenant(
  db: ProductionDB,
  tenantId: string,
  template: AgentTemplate,
): Promise<{ agentId: string }> {
  const { principalId: systemPrincipalId } = await ensureSystemPrincipal(
    db,
    tenantId,
  );

  const reselect = () =>
    db.query.agent.findFirst({
      where: and(eq(agent.tenantId, tenantId), eq(agent.name, template.name)),
    });

  const existing = await reselect();
  if (existing) {
    await db.transaction(async (tx) => {
      await tx
        .update(agent)
        .set({
          description: template.description,
          systemPrompt: template.systemPrompt,
          credentialRequirements: template.credentialRequirements,
          grantRequirements: template.grantRequirements,
          capabilities: template.capabilities,
          modelConfig: template.modelConfig ?? existing.modelConfig,
          modelRequirements: templateModelRequirements(template),
          toolPackages: template.toolPackages ?? [],
          updatedAt: new Date(),
        })
        .where(eq(agent.id, existing.id));
    });
    log.info("Agent template updated", {
      tenantId,
      name: template.name,
      agentId: existing.id,
    });
    return { agentId: existing.id };
  }

  try {
    let agentId!: string;
    await db.transaction(async (tx) => {
      const now = new Date();
      agentId = generateId("agent");

      const agentRows = await tx
        .insert(agent)
        .values({
          id: agentId,
          tenantId,
          creatorPrincipalId: systemPrincipalId,
          name: template.name,
          description: template.description,
          systemPrompt: template.systemPrompt,
          credentialRequirements: template.credentialRequirements,
          grantRequirements: template.grantRequirements,
          capabilities: template.capabilities,
          modelConfig: template.modelConfig ?? null,
          modelRequirements: templateModelRequirements(template),
          toolPackages: template.toolPackages ?? [],
          status: "deployed",
          currentVersion: "1",
          createdAt: now,
          updatedAt: now,
        })
        .returning?.();

      if (!agentRows?.[0]) {
        throw new Error(`Failed to seed agent template ${template.name}`);
      }

      await tx.insert(agentVersion).values({
        id: generateId("agentVersion"),
        agentId,
        version: "1",
        status: "active",
        createdAt: now,
      });

      log.info("Agent template seeded", {
        tenantId,
        name: template.name,
        agentId,
        key: template.key,
      });
    });
    return { agentId };
  } catch (err) {
    // A concurrent replica may have seeded this template between our pre-check
    // and insert; reselect by (tenantId, name) on a fresh connection.
    const existingOnConflict = await reselect();
    if (existingOnConflict) {
      log.info("Agent template seeded concurrently, reselected", {
        tenantId,
        name: template.name,
        agentId: existingOnConflict.id,
      });
      return { agentId: existingOnConflict.id };
    }
    throw err;
  }
}

/** Order-insensitive structural compare — jsonb columns lose key order in PG. */
function jsonEqual(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = canon((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(canon(a) ?? null) === JSON.stringify(canon(b) ?? null);
}

/**
 * True when a tenant's stored agent definition already matches the template on
 * every field `seedAgentTemplateIntoTenant` would write (modelConfig excluded —
 * the seed preserves it with `?? existing`). Keeps the reseed idempotent so the
 * hot paths (new-thread creation, login sync) can call it unconditionally without
 * churning `updatedAt` (and therefore without a needless relaunch). (CL-2517)
 */
export function agentDefMatchesTemplate(
  def: typeof agent.$inferSelect,
  template: AgentTemplate,
): boolean {
  return (
    def.description === template.description &&
    def.systemPrompt === template.systemPrompt &&
    jsonEqual(def.capabilities, template.capabilities) &&
    jsonEqual(def.toolPackages ?? [], template.toolPackages ?? []) &&
    jsonEqual(def.credentialRequirements, template.credentialRequirements) &&
    jsonEqual(def.grantRequirements, template.grantRequirements) &&
    jsonEqual(def.modelRequirements, templateModelRequirements(template))
  );
}

/**
 * Reseed a tenant's agent definition from its template only when it has drifted
 * (CL-2517). Returns whether a reseed happened. No-op when the def is absent or
 * already current, so callers on the hot path can invoke it unconditionally.
 *
 * This is what makes every NEW Myra thread launch with the latest tools: the
 * template gains a tool (e.g. Linear/Granola) but existing per-tenant defs are
 * never otherwise refreshed, so they silently strand users on the old toolset.
 */
export async function reseedAgentTemplateIfStale(
  db: ProductionDB,
  tenantId: string,
  template: AgentTemplate,
): Promise<{ reseeded: boolean; agentId: string | null }> {
  const def = await db.query.agent.findFirst({
    where: and(eq(agent.tenantId, tenantId), eq(agent.name, template.name)),
  });
  if (!def) return { reseeded: false, agentId: null };
  if (agentDefMatchesTemplate(def, template)) {
    return { reseeded: false, agentId: def.id };
  }
  const { agentId } = await seedAgentTemplateIntoTenant(db, tenantId, template);
  log.info("Agent def reseeded from template (drift)", {
    tenantId,
    name: template.name,
    agentId,
  });
  return { reseeded: true, agentId };
}

export async function seedAgentTemplates(
  db: ProductionDB,
  tenantId: string,
): Promise<void> {
  for (const template of AGENT_TEMPLATES) {
    await seedAgentTemplateIntoTenant(db, tenantId, template);
  }
}

/**
 * jsonb key on the global tenant's `config` column holding the admin-controlled
 * list of agent template keys enabled for the org. Stored on the tenant row
 * (not a per-template table) so enablement is a single generic config edit.
 */
const ENABLED_AGENT_TEMPLATES_CONFIG_KEY = "enabledAgentTemplates";

/**
 * Default enablement when the global tenant's config is unset, empty, or has no
 * `enabledAgentTemplates` entry. Every member gets Myra on join; other templates
 * are opt-in by an admin (CL-1531).
 */
const DEFAULT_ENABLED_TEMPLATE_KEYS = ["myra"] as const;

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
export async function getEnabledTemplateKeys(
  db: ProductionDB,
  tenantId: string,
): Promise<AgentTemplate[]> {
  const tenantRow = await db.query.tenant.findFirst({
    where: eq(tenant.id, tenantId),
  });
  if (!tenantRow) {
    throw new Error(
      `Tenant ${tenantId} not found — cannot resolve enabled templates`,
    );
  }

  const config = (tenantRow as { config?: unknown }).config;
  const rawKeys =
    config && typeof config === "object"
      ? (config as Record<string, unknown>)[ENABLED_AGENT_TEMPLATES_CONFIG_KEY]
      : undefined;

  const configuredKeys =
    Array.isArray(rawKeys) && rawKeys.length > 0
      ? rawKeys.filter((k): k is string => typeof k === "string")
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
    log.warn("Dropping unknown enabled agent template keys", {
      tenantId,
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
 * Call this after seedGlobalTenant (for the org tenant) or when an operator
 * stands up a bench tenant. Pass the registered workflow kinds from the route
 * layer where the registry is populated.
 */
export async function seedTenantWorkflows(
  db: ProductionDB,
  tenantId: string,
  workflowKinds: string[],
): Promise<void> {
  if (workflowKinds.length === 0) return;
  const now = new Date();
  for (const kind of workflowKinds) {
    const id = generateId("instance"); // reuse prefix; no dedicated workflow id prefix
    await db
      .insert(enabledWorkflow)
      .values({
        id,
        tenantId,
        principalId: null,
        kind,
        assignments: {},
        enabledAt: now,
      })
      .onConflictDoNothing();
    log.info("Tenant workflow ensured", { tenantId, kind });
  }
}

/** The Myra template key — the always-enabled personal agent. */
export const MYRA_TEMPLATE_KEY = "myra";

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
  opts: {
    /**
     * Target tenant. Optional only as a deprecated back-compat shim for the
     * one-off global-tenant migration (which is coupled to the root tenant by
     * design); when omitted it resolves to the deployment root. All live callers
     * pass it explicitly — there is no tenant special-casing on the hot path.
     */
    tenantId?: string;
    userId: string;
    memberPrincipalId: string;
  },
): Promise<MemberInstance[]> {
  // Domain is deployment-wide (the mail domain), not tenant-specific.
  const { domain } = getConfig().rootTenant;
  let { tenantId } = opts;
  if (!tenantId) {
    const root = await getRootTenantId(db as never);
    if (!root) {
      throw new Error("Root tenant not seeded — cannot provision instances");
    }
    tenantId = root;
  }

  const templates = await getEnabledTemplateKeys(db, tenantId);

  const results: MemberInstance[] = [];

  for (const template of templates) {
    // The shared org definition seeded by CL-1530, keyed on (tenantId, name).
    const def = await db.query.agent.findFirst({
      where: and(eq(agent.tenantId, tenantId), eq(agent.name, template.name)),
    });
    if (!def) {
      log.warn(
        "Enabled template has no seeded org definition — skipping member instance",
        {
          userId: opts.userId,
          templateKey: template.key,
          name: template.name,
        },
      );
      continue;
    }
    const agentId = def.id;

    const reselectMapping = () =>
      db.query.memberAgentInstance.findFirst({
        where: and(
          eq(memberAgentInstance.tenantId, tenantId),
          eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
          eq(memberAgentInstance.templateKey, template.key),
        ),
      });

    const existingMapping = await reselectMapping();
    if (existingMapping) {
      const existingInstance = await db.query.agentInstance.findFirst({
        where: eq(agentInstance.id, existingMapping.instanceId),
      });
      if (existingInstance) {
        await refreshInstanceGrantsFromDefinition(db, {
          agentId: existingInstance.agentId,
          tenantId: existingInstance.tenantId,
          principalId: existingInstance.principalId,
          address: existingInstance.address,
        });
        results.push({
          templateKey: template.key,
          instanceId: existingMapping.instanceId,
        });
        continue;
      }
      // Mapping exists but its instance is gone — recreate the instance below.
    }

    try {
      const created = await db.transaction(async (tx) => {
        const now = new Date();

        const instanceId = generateId("instance");
        const instancePrincipalId = generateId("principal");
        await tx.insert(principal).values({
          id: instancePrincipalId,
          tenantId,
          kind: "agent",
          refId: instanceId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(agentInstance).values({
          id: instanceId,
          agentId,
          tenantId,
          principalId: instancePrincipalId,
          address: `${instanceId}@${domain}`,
          status: "deployed",
          createdAt: now,
          updatedAt: now,
        });

        if (existingMapping) {
          await tx
            .update(memberAgentInstance)
            .set({ agentId, instanceId })
            .where(eq(memberAgentInstance.id, existingMapping.id));
        } else {
          await tx.insert(memberAgentInstance).values({
            id: generateId("instance"),
            tenantId,
            memberPrincipalId: opts.memberPrincipalId,
            templateKey: template.key,
            agentId,
            instanceId,
            createdAt: now,
          });
        }

        // The global tenant's `member` role deliberately carries no grants (see
        // `seedGlobalTenant`), so the owning member needs principal-scoped grants
        // to operate their own personal instance: read powers the chat event
        // stream (`GET /instances/:id/events`), write sends mail, manage aborts a
        // turn. Scoped to this instance id alone — it grants nothing about any
        // other member's instances in the shared tenant (CL-1635).
        for (const action of ["read", "write", "manage"] as const) {
          await tx.insert(grant).values({
            id: generateId("grant"),
            tenantId,
            principalId: opts.memberPrincipalId,
            resource: `instance:${instanceId}`,
            action,
            effect: "allow",
            origin: "system",
            createdAt: now,
            updatedAt: now,
          });
        }

        log.info("Member agent instance provisioned", {
          userId: opts.userId,
          templateKey: template.key,
          agentId,
          instanceId,
        });
        return {
          templateKey: template.key,
          instanceId,
          agentId,
          instancePrincipalId,
        };
      });
      await refreshInstanceGrantsFromDefinition(db, {
        agentId: created.agentId,
        tenantId,
        principalId: created.instancePrincipalId,
        address: `${created.instanceId}@${domain}`,
      });
      results.push({
        templateKey: created.templateKey,
        instanceId: created.instanceId,
      });
    } catch (err) {
      // A concurrent join created the mapping between our pre-check and insert;
      // the (tenant, member, template) unique constraint aborts our transaction.
      // Reselect on a fresh connection.
      const racedMapping = await reselectMapping();
      if (racedMapping) {
        log.info("Member agent instance created concurrently, reselected", {
          userId: opts.userId,
          templateKey: template.key,
          instanceId: racedMapping.instanceId,
        });
        const racedInstance = await db.query.agentInstance.findFirst({
          where: eq(agentInstance.id, racedMapping.instanceId),
        });
        if (racedInstance) {
          await refreshInstanceGrantsFromDefinition(db, {
            agentId: racedInstance.agentId,
            tenantId: racedInstance.tenantId,
            principalId: racedInstance.principalId,
            address: racedInstance.address,
          });
        }
        results.push({
          templateKey: template.key,
          instanceId: racedMapping.instanceId,
        });
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
  return (
    instances.find((i) => i.templateKey === MYRA_TEMPLATE_KEY)?.instanceId ??
    null
  );
}
