import { eq, and, inArray, isNull, like } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema as intxSchema, resolveInstanceSources } from '@intx/db';
import type { DB } from '@intx/db';
import { generateId } from '@intx/hub-common';
import { getLogger } from '@intx/log';
import type { SessionService, SidecarRouter, EventCollectorRegistry } from '@intx/hub-sessions';
import { SessionLaunchError } from '@intx/hub-sessions';
import type { GrantStore } from '@intx/types/authz';
import { startInstanceScheduler } from '@workbench/agent-scheduler';
import { AGENT_TEMPLATES } from '@workbench/agents';
import {
  buildToolDefinitions,
  getToolNamesFromCapabilities,
  getSchedulerIntervalMs,
} from '../lib/tool-registry';
import { buildToolGrantRows, TOOL_GRANT_RESOURCE_PREFIX } from '../lib/tool-grants';
import { memberAgentInstance } from '../db/schema';
import type { HubDb } from '../db';

const log = getLogger(['api', 'agents']);

const { agent, agentInstance, agentSession, credential, grant, principal, provider, tenant } =
  intxSchema;

const LAUNCH_RETRY_DELAY_MS = 1_000;
const MAX_LAUNCH_ATTEMPTS = 3;

// ─── Route ────────────────────────────────────────────────────────

export function createAgentProvisioningRouter(
  db: DB['db'],
  sessionService: SessionService,
  grantStore: GrantStore,
  sidecarRouter: SidecarRouter,
  eventCollectors: EventCollectorRegistry
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  // List agent instances for a given tenant
  app.get('/agents', async (c) => {
    const userId = c.get('userId');
    const tenantId = c.req.query('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenantId query parameter required' }, 400);
    }

    const callerPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, userId)
      ),
    });

    if (!callerPrincipal) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const instances = await db.query.agentInstance.findMany({
      where: and(
        eq(agentInstance.tenantId, tenantId),
        inArray(agentInstance.status, ['deployed', 'running', 'stopped']),
        // Removed instances set endedAt; keep them out of the list so they
        // disappear from the rail rather than lingering as "Stopped".
        isNull(agentInstance.endedAt)
      ),
    });

    // Exclude instances that are the calling user's personal agent. Personal
    // agents (kind: 'personal' templates) appear in the dedicated PersonalAgentChat
    // panel — not the shared agent list.
    const personalTemplateKeys = new Set(
      AGENT_TEMPLATES.filter((t) => t.kind === 'personal').map((t) => t.key)
    );
    const hubDb = db as unknown as HubDb;
    const personalMappings =
      personalTemplateKeys.size > 0
        ? await hubDb.query.memberAgentInstance.findMany({
            where: and(
              eq(memberAgentInstance.tenantId, tenantId),
              eq(memberAgentInstance.memberPrincipalId, callerPrincipal.id),
              inArray(memberAgentInstance.templateKey, [...personalTemplateKeys])
            ),
          })
        : [];
    const personalInstanceIds = new Set(personalMappings.map((m) => m.instanceId));
    const sharedInstances = instances.filter((i) => !personalInstanceIds.has(i.id));

    const agentIds = [...new Set(sharedInstances.map((i) => i.agentId))];
    const agentRows =
      agentIds.length > 0
        ? await db.query.agent.findMany({ where: inArray(agent.id, agentIds) })
        : [];
    const agentMap = new Map(agentRows.map((a) => [a.id, a]));

    const result = sharedInstances.map((inst) => {
      const agentRow = agentMap.get(inst.agentId);
      return {
        id: inst.id,
        agentId: inst.agentId,
        agentName: agentRow?.name ?? 'Unknown',
        tenantId: inst.tenantId,
        address: inst.address,
        status: inst.status,
        credentialRequirements: (agentRow?.credentialRequirements ?? []) as Array<{
          providerName: string;
          source: string;
          name?: string;
        }>,
        capabilities: (agentRow?.capabilities ?? null) as Record<string, unknown> | null,
        createdAt: inst.createdAt.toISOString(),
      };
    });

    return c.json({ data: result });
  });

  app.delete('/tenants/:tenantId/agents/instances/:instanceId', async (c) => {
    const userId = c.get('userId');
    const tenantId = c.req.param('tenantId');
    const instanceId = c.req.param('instanceId');

    const callerPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, userId)
      ),
    });
    if (!callerPrincipal) return c.json({ error: 'Forbidden' }, 403);

    const instance = await db.query.agentInstance.findFirst({
      where: and(eq(agentInstance.id, instanceId), eq(agentInstance.tenantId, tenantId)),
    });
    if (!instance) return c.json({ error: 'Agent instance not found' }, 404);

    const now = new Date();
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB['db'];
      await tx
        .update(agentInstance)
        .set({ status: 'stopped', endedAt: now, updatedAt: now })
        .where(eq(agentInstance.id, instanceId));
      // Remove any personal-agent mapping so /me returns paInstanceId: null,
      // which surfaces the onboarding screen (re-deploy) rather than a broken
      // "provisioning" state.
      const hubTx = tx as unknown as HubDb;
      await hubTx.delete(memberAgentInstance).where(eq(memberAgentInstance.instanceId, instanceId));
    });

    // Notify the sidecar so it tears down the agent immediately. Without this,
    // the sidecar holds the agent in memory and will try to re-register it on
    // reconnect, failing challenge because endedAt is now set in the DB.
    await sessionService.endSession(instance.address, 'user deleted instance').catch((err) => {
      log.warn('Failed to end sidecar session on instance delete', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.body(null, 204);
  });

  // Launch (or relaunch) a session for an agent instance.
  // Credentials are resolved via Interchange's credential-requirement resolution — no IDs needed.
  app.post('/instances/:instanceId/sessions', async (c) => {
    const userId = c.get('userId');
    const instanceId = c.req.param('instanceId');

    const instance = await db.query.agentInstance.findFirst({
      where: eq(agentInstance.id, instanceId),
    });
    if (!instance) {
      return c.json({ error: 'Instance not found' }, 404);
    }

    const callerPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, instance.tenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, userId)
      ),
    });
    if (!callerPrincipal) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // If the agent is already reachable on a connected sidecar, it is live — do
    // not re-launch. Re-launching re-deploys the same address, which the sidecar
    // rejects with "Agent already exists"; that rejected deploy evicts the live
    // agent from the router address index, after which mail 502s with "agent is
    // unreachable". The frontend fires this route proactively (and sometimes
    // twice) right after deploy, so it must be idempotent for a healthy
    // instance. The 409-recovery path still works: a genuinely-down instance is
    // not routable, so it falls through to relaunch below.
    if (sidecarRouter.getRoutableAddresses().includes(instance.address)) {
      return c.json({ launched: true });
    }

    // A stopped instance with endedAt set was explicitly deleted — it cannot be
    // relaunched. The caller should provision a fresh instance instead.
    if (instance.status === 'stopped' && instance.endedAt !== null) {
      return c.json({ error: 'Instance was deleted. Provision a new instance.' }, 409);
    }

    // Reset a stopped instance so the sidecar treats it as a fresh launch.
    if (instance.status === 'stopped') {
      const resetNow = new Date();
      await db
        .update(agentInstance)
        .set({ status: 'deployed', endedAt: null, updatedAt: resetNow })
        .where(eq(agentInstance.id, instanceId));
    }

    const tenantRow = await db.query.tenant.findFirst({
      where: eq(tenant.id, instance.tenantId),
    });
    if (!tenantRow?.domain) {
      return c.json({ error: 'Tenant configuration missing' }, 500);
    }

    const agentRow = await db.query.agent.findFirst({
      where: eq(agent.id, instance.agentId),
    });
    if (!agentRow?.systemPrompt) {
      return c.json({ error: 'Agent configuration missing' }, 500);
    }

    const now = new Date();

    let launched = false;
    let launchError: string | undefined;

    try {
      const session = await launchAgentSession(db, sessionService, grantStore, eventCollectors, {
        agentId: instance.agentId,
        instanceId: instance.id,
        instancePrincipalId: instance.principalId,
        tenantId: instance.tenantId,
        tenantDomain: tenantRow.domain,
        systemPrompt: agentRow.systemPrompt,
        now,
      });
      const intervalMs = getSchedulerIntervalMs(agentRow.capabilities);
      if (intervalMs !== undefined) {
        startInstanceScheduler({
          agentAddress: session.address,
          sessionId: session.sessionId,
          tenantId: instance.tenantId,
          sessionService,
          events: sidecarRouter.events,
          intervalMs,
        });
      }
      launched = true;
    } catch (err) {
      // If the sidecar already has the agent provisioned (e.g. a race between
      // the orchestrator's reconnect path and this explicit launch), treat it
      // as success. The agent is live; the frontend can proceed.
      if (isAgentAlreadyExistsError(err)) {
        await db
          .update(agentInstance)
          .set({ status: 'running', updatedAt: new Date() })
          .where(eq(agentInstance.id, instanceId));
        launched = true;
      } else {
        launchError = err instanceof Error ? err.message : String(err);
        log.error('Failed to launch agent session', {
          instanceId,
          error: launchError,
        });
      }
    }

    if (!launched) {
      return c.json({ error: launchError ?? 'Failed to launch agent session' }, 503);
    }

    return c.json({ launched: true });
  });

  // List deployable agent templates for the catalog UI.
  app.get('/agents/templates', (c) => {
    const templates = AGENT_TEMPLATES.filter((t) => t.deployable !== false).map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
    }));
    return c.json({ data: templates });
  });

  // Deploy an agent instance from a pre-built template.
  // Creates a principal + agentInstance + memberAgentInstance row then launches
  // the session. The shared agent definition is the one seeded at boot time in
  // the global org tenant.
  app.post('/tenants/:tenantId/agents/instances', async (c) => {
    const userId = c.get('userId');
    const tenantId = c.req.param('tenantId');

    const callerPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, userId)
      ),
    });
    if (!callerPrincipal) return c.json({ error: 'Forbidden' }, 403);

    const body = (await c.req.json().catch(() => ({}))) as { templateKey?: unknown };
    const templateKey = typeof body.templateKey === 'string' ? body.templateKey : '';
    if (!templateKey) return c.json({ error: 'templateKey is required' }, 400);

    const template = AGENT_TEMPLATES.find((t) => t.key === templateKey);
    if (!template || template.deployable === false) {
      return c.json({ error: 'Unknown or non-deployable template' }, 400);
    }

    const tenantRow = await db.query.tenant.findFirst({ where: eq(tenant.id, tenantId) });
    if (!tenantRow?.domain) return c.json({ error: 'Tenant configuration missing' }, 500);

    // Walk up the tenant hierarchy until we find the agent definition or exhaust the tree.
    // Start from tenantRow.parentId — tenantRow is already fetched and checked above.
    // Cycle guard prevents infinite loops on malformed tenant data.
    const findDefInHierarchy = async (startTenantId: string) => {
      const visited = new Set<string>();
      let cursor: string | null = startTenantId;
      while (cursor !== null) {
        if (visited.has(cursor)) break;
        visited.add(cursor);
        const candidate = await db.query.agent.findFirst({
          where: and(eq(agent.tenantId, cursor), eq(agent.name, template.name)),
        });
        if (candidate) return candidate;
        const tenantResult: { parentId: string | null } | undefined =
          await db.query.tenant.findFirst({ where: eq(tenant.id, cursor) });
        cursor = tenantResult?.parentId ?? null;
      }
      return undefined;
    };
    const def = await findDefInHierarchy(tenantRow.parentId ?? tenantId);
    if (!def) {
      return c.json({ error: `Agent definition for template "${templateKey}" not found` }, 404);
    }

    const hubDb = db as unknown as HubDb;

    const now = new Date();
    const instanceId = generateId('instance');
    let instancePrincipalId = '';

    await hubDb.transaction(async (rawTx) => {
      const tx = rawTx as unknown as HubDb;

      // Each instance gets its own principal scoped to the user's workbench tenant.
      // refId = instanceId keeps principals isolated per user — two users deploying
      // the same shared definition get separate principals.
      const newPrincipalId = generateId('principal');
      await tx.insert(principal).values({
        id: newPrincipalId,
        tenantId,
        kind: 'agent',
        refId: instanceId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      instancePrincipalId = newPrincipalId;

      await tx.insert(agentInstance).values({
        id: instanceId,
        agentId: def.id,
        tenantId,
        principalId: instancePrincipalId,
        address: `${instanceId}@${tenantRow.domain}`,
        status: 'deployed',
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(memberAgentInstance).values({
        id: generateId('instance'),
        tenantId,
        memberPrincipalId: callerPrincipal.id,
        templateKey,
        agentId: def.id,
        instanceId,
        createdAt: now,
      });
    });

    try {
      const session = await launchAgentSession(db, sessionService, grantStore, eventCollectors, {
        agentId: def.id,
        instanceId,
        instancePrincipalId,
        tenantId,
        tenantDomain: tenantRow.domain,
        systemPrompt: def.systemPrompt ?? '',
        now,
      });
      const intervalMs = getSchedulerIntervalMs(def.capabilities);
      if (intervalMs !== undefined) {
        startInstanceScheduler({
          agentAddress: session.address,
          sessionId: session.sessionId,
          tenantId,
          sessionService,
          events: sidecarRouter.events,
          intervalMs,
        });
      }
    } catch (err) {
      log.warn('Agent instance created but session launch failed', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return c.json({ instanceId, created: true }, 201);
  });

  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Reconcile the persisted `tool:*` grant rows for an instance principal to the
 * given tool set. Deletes the principal's existing system tool grants and
 * re-inserts the current set, so `collectGrants` returns them at launch AND on
 * the orchestrator's reconnect path. Idempotent; safe to call on every launch.
 */
export async function persistInstanceToolGrants(
  db: DB['db'],
  opts: {
    tenantId: string;
    principalId: string;
    toolNames: string[];
    now: Date;
  }
): Promise<void> {
  const { tenantId, principalId, toolNames, now } = opts;
  const rows = buildToolGrantRows(toolNames, { tenantId, principalId }, now);
  await db.transaction(async (tx) => {
    await tx
      .delete(grant)
      .where(
        and(
          eq(grant.principalId, principalId),
          eq(grant.origin, 'system'),
          like(grant.resource, `${TOOL_GRANT_RESOURCE_PREFIX}%`)
        )
      );
    if (rows.length > 0) {
      await tx.insert(grant).values(rows);
    }
  });
}

export type GrantRequirementRow = {
  source: 'tenant' | 'creator' | 'invoker';
  resource: string;
  action: string;
  effect?: 'allow' | 'deny';
  conditions?: Record<string, unknown> | null;
};

/**
 * Materialize an agent definition's `grantRequirements` onto its instance
 * principal so `collectGrants` returns them in the launch deploy frame. Mirrors
 * Interchange's native deploy route (hub-api instances.ts), which resolves and
 * writes these rows before launch. The dynamic per-tenant deliver grant
 * (`tenant:<tenantId>` / `deliver`) — dropped from the seeded definition because
 * it depends on the launch-time tenant — is added here so mail delivery is
 * authorized. Idempotent: clears prior requirement-origin grants for the
 * principal and re-inserts, so launch and reconnect agree.
 */
export async function persistInstanceGrantRequirements(
  db: DB['db'],
  opts: {
    tenantId: string;
    principalId: string;
    grantRequirements: GrantRequirementRow[];
    now: Date;
  }
): Promise<void> {
  const { tenantId, principalId, grantRequirements, now } = opts;

  const rows = grantRequirements.map((req) => ({
    id: generateId('grant'),
    tenantId,
    principalId,
    resource: req.resource,
    action: req.action,
    effect: req.effect ?? ('allow' as const),
    conditions: req.conditions ?? null,
    origin: req.source === 'creator' ? ('creator' as const) : ('invoker' as const),
    createdAt: now,
    updatedAt: now,
  }));

  // The dynamic per-tenant deliver grant, computed at launch (not seeded).
  rows.push({
    id: generateId('grant'),
    tenantId,
    principalId,
    resource: `tenant:${tenantId}`,
    action: 'deliver',
    effect: 'allow' as const,
    conditions: null,
    origin: 'invoker' as const,
    createdAt: now,
    updatedAt: now,
  });

  await db.transaction(async (tx) => {
    await tx
      .delete(grant)
      .where(
        and(eq(grant.principalId, principalId), inArray(grant.origin, ['creator', 'invoker']))
      );
    if (rows.length > 0) {
      await tx.insert(grant).values(rows);
    }
  });
}

export async function launchAgentSession(
  db: DB['db'],
  sessionService: SessionService,
  grantStore: GrantStore,
  eventCollectors: EventCollectorRegistry,
  opts: {
    agentId: string;
    instanceId: string;
    instancePrincipalId: string;
    tenantId: string;
    tenantDomain: string;
    systemPrompt: string;
    now: Date;
  }
): Promise<{ address: string; sessionId: string }> {
  const { agentId, instanceId, instancePrincipalId, tenantId, tenantDomain, systemPrompt, now } =
    opts;
  const address = `${instanceId}@${tenantDomain}`;

  const rawSources = await resolveInstanceSources(db, tenantId, {
    agentId,
    sessionId: null,
  });
  if (rawSources.length === 0) {
    throw new Error('No resolvable inference sources for agent credential requirements');
  }

  const sources = rawSources;
  const defaultSource = sources[0]!.id;

  const agentRow = await db.query.agent.findFirst({
    where: eq(agent.id, agentId),
  });
  if (!agentRow) throw new Error(`Agent not found: ${agentId}`);
  const toolNames = getToolNamesFromCapabilities(agentRow.capabilities ?? null);
  const tools = buildToolDefinitions(toolNames);

  // Persist the agent's tool grants on the instance principal before collecting.
  // Tool authorization is trust-by-configuration (any configured tool is allowed,
  // origin 'system'). These rows MUST be persisted, not synthesized in memory:
  // the orchestrator's reconnect path re-sends only what collectGrants reads from
  // the DB, so in-memory tool grants were silently dropped on every sidecar
  // reconnect (CL-1398). Persisting makes launch and reconnect agree.
  await persistInstanceToolGrants(db, {
    tenantId,
    principalId: instancePrincipalId,
    toolNames,
    now,
  });

  // Materialize the agent definition's grant requirements onto the instance
  // principal — the same step Interchange's native deploy route performs
  // (hub-api instances.ts grant-requirement resolution). Without this, the
  // collectGrants snapshot below is missing capabilities the agent declares it
  // needs (e.g. Myra's tool:mail_send/invoke and the per-tenant deliver grant),
  // so mail delivery failed with sidecar_unavailable. These are our own seeded,
  // trusted definitions deployed through an authenticated route, so we
  // materialize the declared requirements directly rather than re-running the
  // creator/invoker delegation check.
  await persistInstanceGrantRequirements(db, {
    tenantId,
    principalId: instancePrincipalId,
    grantRequirements: (agentRow.grantRequirements ?? []) as GrantRequirementRow[],
    now,
  });

  const grants = await grantStore.collectGrants(instancePrincipalId, tenantId);

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_LAUNCH_ATTEMPTS; attempt++) {
    // Clean up any orphaned session rows from a previous failed attempt before
    // creating a new one. Without this, each retry leaves an active session row
    // pointing at a sidecar agent that was never started successfully.
    const existing = await db.query.agentInstance.findFirst({
      where: eq(agentInstance.id, instanceId),
    });
    if (existing?.sessionId) {
      await db
        .update(agentSession)
        .set({ status: 'ended', updatedAt: new Date() })
        .where(and(eq(agentSession.id, existing.sessionId), eq(agentSession.status, 'active')));
    }

    const sessionId = generateId('session');
    await db.insert(agentSession).values({
      id: sessionId,
      tenantId,
      agentId,
      principalId: instancePrincipalId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await db
      .update(agentInstance)
      .set({ sessionId, updatedAt: now })
      .where(eq(agentInstance.id, instanceId));

    const launchConfig = {
      agentAddress: address,
      agentId,
      instanceId,
      config: {
        sessionId,
        agentId,
        tenantId,
        principalId: instancePrincipalId,
        agentAddress: address,
        systemPrompt,
        tools,
        grants,
        sources,
        defaultSource,
      },
      deployContent: { systemPrompt },
    };

    try {
      await sessionService.launchSession(launchConfig);
      // Register the event collector before updating status so inference events
      // arriving immediately after launch are captured rather than dropped.
      eventCollectors.create(address, tenantId, sessionId, instanceId);
      await db
        .update(agentInstance)
        .set({ status: 'running', updatedAt: new Date() })
        .where(eq(agentInstance.id, instanceId));
      log.info('Agent session launched', { instanceId, agentId, tenantId });
      return { address, sessionId };
    } catch (err) {
      lastError = err;
      // Provision-phase failures mean the sidecar already has the agent or
      // rejected the config. Neither condition improves with retries.
      if (err instanceof SessionLaunchError && err.phase === 'provision') break;
      if (attempt < MAX_LAUNCH_ATTEMPTS - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, LAUNCH_RETRY_DELAY_MS));
      }
    }
  }

  // Mark the last session row as ended since the launch ultimately failed.
  const finalInstance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, instanceId),
  });
  if (finalInstance?.sessionId) {
    await db
      .update(agentSession)
      .set({ status: 'ended', updatedAt: new Date() })
      .where(and(eq(agentSession.id, finalInstance.sessionId), eq(agentSession.status, 'active')));
  }

  // Clean up any tool grants written before the launch loop — they're orphaned
  // since no session launched, and would otherwise be returned by collectGrants
  // on the next reconnect attempt with incorrect scope.
  await db
    .delete(grant)
    .where(
      and(
        eq(grant.principalId, instancePrincipalId),
        eq(grant.origin, 'system'),
        like(grant.resource, `${TOOL_GRANT_RESOURCE_PREFIX}%`)
      )
    );

  throw lastError;
}

// Relaunch a Myra instance's session if it has no active session but has credentials granted.
// Called from GET /v1/me so existing users get Myra running automatically on login.
export async function relaunchInstanceIfNeeded(
  db: DB['db'],
  sessionService: SessionService,
  grantStore: GrantStore,
  eventCollectors: EventCollectorRegistry,
  instanceId: string,
  sidecarRouter: SidecarRouter
): Promise<void> {
  const instance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, instanceId),
  });
  if (!instance) return;

  // A stopped instance with endedAt set was explicitly deleted — it cannot be
  // relaunched.
  if (instance.status === 'stopped' && instance.endedAt !== null) return;

  // If the agent is already reachable on a connected sidecar, it is live — do
  // not relaunch. Re-launching re-deploys the same address, which the sidecar
  // rejects with "Agent already exists"; that rejected deploy evicts the live
  // agent from the router's address index, after which mail delivery fails with
  // "agent is unreachable" (502). Relaunch only when the agent is genuinely not
  // routable — e.g. a sidecar restart cleared the index, or the hub boot reset
  // the instance status to 'deployed'. This keeps the post-reconnect recovery
  // intent without breaking healthy, just-deployed instances.
  if (sidecarRouter.getRoutableAddresses().includes(instance.address)) return;

  const tenantRow = await db.query.tenant.findFirst({
    where: eq(tenant.id, instance.tenantId),
  });
  if (!tenantRow?.domain) return;

  const agentRow = await db.query.agent.findFirst({
    where: eq(agent.id, instance.agentId),
  });
  if (!agentRow?.systemPrompt) return;

  // Guard: do not attempt launch if the tenant is missing any of the credentials this
  // agent requires. Without this check, every GET /v1/me for a pre-onboarding user fires
  // a launch attempt that always fails with "No resolvable inference sources".
  const requirements = (agentRow.credentialRequirements ?? []) as Array<{
    providerName: string;
    source: string;
  }>;
  const tenantRequirements = requirements.filter((r) => r.source === 'tenant');
  if (tenantRequirements.length > 0) {
    for (const req of tenantRequirements) {
      const [hasCred] = await db
        .select({ id: credential.id })
        .from(credential)
        .innerJoin(provider, eq(credential.providerId, provider.id))
        .where(
          and(
            eq(credential.tenantId, instance.tenantId),
            isNull(credential.principalId),
            eq(credential.status, 'active'),
            eq(provider.name, req.providerName)
          )
        )
        .limit(1);
      if (!hasCred) return;
    }
  }

  let launched: { address: string; sessionId: string };
  try {
    launched = await launchAgentSession(db, sessionService, grantStore, eventCollectors, {
      agentId: instance.agentId,
      instanceId: instance.id,
      instancePrincipalId: instance.principalId,
      tenantId: instance.tenantId,
      tenantDomain: tenantRow.domain,
      systemPrompt: agentRow.systemPrompt,
      now: new Date(),
    });
  } catch (err) {
    // Agent already running on the sidecar — nothing to do.
    if (isAgentAlreadyExistsError(err)) return;
    throw err;
  }

  const intervalMs = getSchedulerIntervalMs(agentRow.capabilities);
  if (intervalMs !== undefined) {
    startInstanceScheduler({
      agentAddress: launched.address,
      sessionId: launched.sessionId,
      tenantId: instance.tenantId,
      sessionService,
      events: sidecarRouter.events,
      intervalMs,
    });
  }
}

/**
 * Returns true when the error indicates the sidecar already has the agent
 * provisioned. This can happen in a race between the orchestrator's reconnect
 * path and an explicit launch call — the agent is live and the caller should
 * treat the situation as success.
 */
function isAgentAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('Agent already exists for address');
}
