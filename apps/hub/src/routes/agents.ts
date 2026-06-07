import { eq, and, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  schema as intxSchema,
  resolveCredentialById,
  resolveInstanceSources,
  getAncestorChain,
} from '@intx/db';
import type { DB } from '@intx/db';
import { generateId } from '@intx/hub-common';
import { getLogger } from '@intx/log';
import type { SessionService, SidecarRouter } from '@intx/hub-sessions';
import { SessionLaunchError } from '@intx/hub-sessions';
import type { GrantStore } from '@intx/types/authz';
import { type } from 'arktype';
import { decryptSecret, encryptSecret } from '@workbench/hub-crypto';
import { getConfig } from '../config';
import { repairTenantAgentCredentials } from '../lib/agent-credential-repair';
import {
  buildToolDefinitions,
  getToolNamesFromCapabilities,
  KNOWN_TOOL_NAMES,
} from '../lib/tool-registry';

const log = getLogger(['api', 'agents']);

const {
  agent,
  agentInstance,
  agentSession,
  credential,
  grant,
  principal,
  provider: providerTable,
  tenant,
} = intxSchema;

const LAUNCH_RETRY_DELAY_MS = 1_000;
const MAX_LAUNCH_ATTEMPTS = 3;

// ─── Request shapes ────────────────────────────────────────────────

const INFERENCE_PROVIDER_NAMES = [
  'anthropic',
  'openai',
  'google-genai',
  'openai-compatible',
] as const;
type InferenceProviderName = (typeof INFERENCE_PROVIDER_NAMES)[number];

const PROVIDER_BASE_URLS: Record<InferenceProviderName, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  'google-genai': 'https://generativelanguage.googleapis.com',
  'openai-compatible': '',
};

function isInferenceProviderName(provider: string): provider is InferenceProviderName {
  return INFERENCE_PROVIDER_NAMES.includes(provider as InferenceProviderName);
}

const ProvisionAgentBody = type({
  tenantId: 'string',
  name: 'string',
  systemPrompt: 'string',
  'credentialIds?': 'string[]',
});

type ProvisionAgentBodyType = typeof ProvisionAgentBody.infer;

const CreateTenantCredentialBody = type({
  provider: 'string',
  apiKey: 'string',
  name: 'string',
  'model?': 'string',
  'baseURL?': 'string',
});

// ─── Route ────────────────────────────────────────────────────────

export function createAgentProvisioningRouter(
  db: DB['db'],
  sessionService: SessionService,
  grantStore: GrantStore,
  sidecarRouter: SidecarRouter
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
        inArray(agentInstance.status, ['deployed', 'running', 'stopped'])
      ),
    });

    const agentIds = [...new Set(instances.map((i) => i.agentId))];
    const agentRows =
      agentIds.length > 0
        ? await db.query.agent.findMany({ where: inArray(agent.id, agentIds) })
        : [];
    const agentMap = new Map(agentRows.map((a) => [a.id, a]));

    const result = instances.map((inst) => {
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
      await tx
        .update(agent)
        .set({ status: 'stopped', updatedAt: now })
        .where(eq(agent.id, instance.agentId));
    });

    return c.body(null, 204);
  });

  // Provision an agent with existing credentials
  app.post('/agents', async (c) => {
    const userId = c.get('userId');
    const raw = await c.req.json().catch(() => null);
    if (!raw) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = ProvisionAgentBody(raw);
    if (parsed instanceof type.errors) {
      return c.json({ error: parsed.summary }, 400);
    }

    const body = parsed as ProvisionAgentBodyType;

    const callerPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, body.tenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, userId)
      ),
    });

    if (!callerPrincipal) {
      return c.json({ error: 'No principal found for this tenant' }, 403);
    }

    const tenantRow = await db.query.tenant.findFirst({
      where: eq(tenant.id, body.tenantId),
    });

    if (!tenantRow) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    if (!tenantRow.domain) {
      return c.json({ error: 'Tenant has no domain configured' }, 500);
    }

    const now = new Date();

    const txResult = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB['db'];

      return await ensureAgentInstance(tx, {
        tenantId: body.tenantId,
        tenantDomain: tenantRow.domain,
        agentName: body.name,
        systemPrompt: body.systemPrompt,
        creatorPrincipalId: callerPrincipal.id,
        now,
        ...(body.credentialIds !== undefined ? { credentialIds: body.credentialIds } : {}),
      });
    });

    if ('error' in txResult) {
      return c.json({ error: txResult.error }, txResult.status);
    }

    const { instanceId, agentId, instancePrincipalId, isNew } = txResult;

    let launched = false;
    let launchError: string | undefined;

    if (isNew) {
      try {
        await launchAgentSession(db, sessionService, grantStore, {
          agentId,
          instanceId,
          instancePrincipalId,
          tenantId: body.tenantId,
          tenantDomain: tenantRow.domain,
          systemPrompt: body.systemPrompt,
          now,
        });
        launched = true;
      } catch (err) {
        launchError = err instanceof Error ? err.message : String(err);
        log.error('Failed to launch agent session after provisioning', {
          instanceId,
          error: launchError,
        });
      }
    }

    return c.json(
      {
        instanceId,
        agentId,
        agentName: body.name,
        tenantId: body.tenantId,
        launched,
        ...(launchError !== undefined ? { launchError } : {}),
      },
      201
    );
  });

  // Create a named LLM credential (provider + encrypted secret) for a tenant.
  app.post('/tenants/:tenantId/credentials', async (c) => {
    const userId = c.get('userId');
    const tenantId = c.req.param('tenantId');

    const raw = await c.req.json().catch(() => null);
    if (!raw) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = CreateTenantCredentialBody(raw);
    if (parsed instanceof type.errors) {
      return c.json({ error: parsed.summary }, 400);
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

    const tenantRow = await db.query.tenant.findFirst({
      where: eq(tenant.id, tenantId),
    });
    if (!tenantRow) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    const providerName = parsed.provider.trim();
    const credentialName = parsed.name.trim();
    const apiKey = parsed.apiKey.trim();
    const model = parsed.model?.trim() ?? '';
    const baseURL = parsed.baseURL?.trim() ?? '';
    const isInferenceProvider = isInferenceProviderName(providerName);

    if (providerName.length === 0) {
      return c.json({ error: 'provider is required' }, 400);
    }
    if (credentialName.length === 0) {
      return c.json({ error: 'name is required' }, 400);
    }
    if (apiKey.length === 0) {
      return c.json({ error: 'apiKey is required' }, 400);
    }
    if (isInferenceProvider && model.length === 0) {
      return c.json({ error: 'model is required for inference providers' }, 400);
    }
    if (providerName === 'openai-compatible' && baseURL.length === 0) {
      return c.json({ error: 'baseURL is required for OpenAI-compatible providers' }, 400);
    }

    const providerBaseURL =
      baseURL || (isInferenceProvider ? PROVIDER_BASE_URLS[providerName] : '');
    const providerModel = isInferenceProvider ? model : '';

    const now = new Date();

    let credentialId!: string;
    let providerId!: string;

    try {
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB['db'];
        // ensureProvider: upsert semantics needed because Interchange's POST /providers returns
        // 409 on duplicate — we need idempotent get-or-create for repeated provisioning flows.
        providerId = await ensureProvider(
          tx,
          tenantId,
          providerName,
          providerName,
          providerBaseURL,
          providerModel,
          now
        );

        // Encrypt secret before storage — Interchange stores plaintext; encryption is a workbench
        // invariant applied at the write boundary.
        const encryptedSecret = encryptSecret(getConfig().credentialKeys, tenantId, apiKey);

        const [inserted] = await tx
          .insert(credential)
          .values({
            id: generateId('credential'),
            tenantId,
            providerId,
            principalId: null,
            name: credentialName,
            type: 'api_key',
            secret: encryptedSecret,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();

        if (!inserted) {
          // Conflict detected atomically by empty .returning() — unique(tenantId, name) violated.
          throw Object.assign(
            new Error(`Credential named '${credentialName}' already exists in this tenant`),
            { status: 409 }
          );
        }

        credentialId = inserted.id;

        // Grant the creating principal manage access so Interchange's DELETE/PATCH endpoints work.
        await tx.insert(grant).values({
          id: generateId('grant'),
          tenantId,
          principalId: callerPrincipal.id,
          resource: `credential:${credentialId}`,
          action: '*',
          effect: 'allow',
          origin: 'creator',
          createdAt: now,
          updatedAt: now,
        });
      });
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 409) return c.json({ error: e.message }, 409);
      throw err;
    }

    void pushDecryptedSourceUpdates(db, sidecarRouter, tenantId);

    return c.json({ credentialId, providerId }, 201);
  });

  // List enriched credentials for a tenant (includes provider info and agent grant counts).
  app.get('/tenants/:tenantId/credentials', async (c) => {
    const userId = c.get('userId');
    const tenantId = c.req.param('tenantId');

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

    const tenantChain = await getAncestorChain(db, tenantId);
    const credentials = await db.query.credential.findMany({
      where: inArray(credential.tenantId, tenantChain),
    });

    const result = await Promise.all(
      credentials.map(async (cred) => {
        const prov = await db.query.provider.findFirst({
          where: eq(providerTable.id, cred.providerId),
        });

        const meta = prov?.metadata as { baseURL?: string; model?: string } | null;
        return {
          id: cred.id,
          name: cred.name,
          tenantId: cred.tenantId,
          providerPlugin: prov?.plugin ?? '',
          providerName: prov?.name ?? '',
          providerId: cred.providerId,
          status: cred.status,
          baseURL: meta?.baseURL ?? '',
          model: meta?.model ?? '',
          createdAt: cred.createdAt.toISOString(),
          updatedAt: cred.updatedAt.toISOString(),
        };
      })
    );

    return c.json({ data: result });
  });

  // Update an existing credential: name, API key, and/or provider baseURL + model.
  app.patch('/tenants/:tenantId/credentials/:credentialId', async (c) => {
    const userId = c.get('userId');
    const tenantId = c.req.param('tenantId');
    const credentialId = c.req.param('credentialId');

    const raw = await c.req.json().catch(() => null);
    if (!raw) return c.json({ error: 'Invalid JSON body' }, 400);

    const callerPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, userId)
      ),
    });
    if (!callerPrincipal) return c.json({ error: 'Forbidden' }, 403);

    const cred = await db.query.credential.findFirst({
      where: and(eq(credential.id, credentialId), eq(credential.tenantId, tenantId)),
    });
    if (!cred) return c.json({ error: 'Credential not found' }, 404);

    const now = new Date();
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB['db'];

      const credUpdates: Record<string, unknown> = { updatedAt: now };
      if (typeof raw.name === 'string' && raw.name.trim()) {
        credUpdates['name'] = raw.name.trim();
      }
      if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) {
        credUpdates['secret'] = encryptSecret(
          getConfig().credentialKeys,
          tenantId,
          raw.apiKey.trim()
        );
      }
      await tx.update(credential).set(credUpdates).where(eq(credential.id, credentialId));

      if (typeof raw.baseURL === 'string' || typeof raw.model === 'string') {
        const prov = await tx.query.provider.findFirst({
          where: eq(providerTable.id, cred.providerId),
        });
        const existingMeta = (prov?.metadata as { baseURL?: string; model?: string } | null) ?? {};
        await tx
          .update(providerTable)
          .set({
            metadata: {
              baseURL:
                typeof raw.baseURL === 'string' ? raw.baseURL.trim() : (existingMeta.baseURL ?? ''),
              model: typeof raw.model === 'string' ? raw.model.trim() : (existingMeta.model ?? ''),
            },
            updatedAt: now,
          })
          .where(eq(providerTable.id, cred.providerId));
      }
    });

    void pushDecryptedSourceUpdates(db, sidecarRouter, tenantId);

    return c.json({ credentialId }, 200);
  });

  // Assign a tenant credential to an agent's credentialRequirements.
  // Replaces any existing tenant requirement on the agent with one pointing at
  // the named credential. Pass credentialId: null to clear the assignment.
  app.patch('/tenants/:tenantId/agents/:agentId/credential', async (c) => {
    const userId = c.get('userId');
    const tenantId = c.req.param('tenantId');
    const agentId = c.req.param('agentId');

    const raw = await c.req.json().catch(() => null);
    if (!raw || (typeof raw.credentialId !== 'string' && raw.credentialId !== null)) {
      return c.json({ error: 'credentialId (string or null) required' }, 400);
    }

    const callerPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, userId)
      ),
    });
    if (!callerPrincipal) return c.json({ error: 'Forbidden' }, 403);

    let effectiveTenantId = tenantId;
    let agentRow = await db.query.agent.findFirst({
      where: and(eq(agent.id, agentId), eq(agent.tenantId, tenantId)),
    });

    // Older web builds sometimes submit the credential tenant in the URL instead
    // of the agent definition tenant. Keep the endpoint forgiving while still
    // requiring membership in the actual agent tenant before mutating anything.
    if (!agentRow) {
      const agentById = await db.query.agent.findFirst({
        where: eq(agent.id, agentId),
      });
      if (!agentById) return c.json({ error: 'Agent not found' }, 404);

      const effectiveCallerPrincipal = await db.query.principal.findFirst({
        where: and(
          eq(principal.tenantId, agentById.tenantId),
          eq(principal.kind, 'user'),
          eq(principal.refId, userId)
        ),
      });
      if (!effectiveCallerPrincipal) return c.json({ error: 'Forbidden' }, 403);

      effectiveTenantId = agentById.tenantId;
      agentRow = agentById;
    }

    const reqs: Array<Record<string, unknown>> = Array.isArray(agentRow.credentialRequirements)
      ? (agentRow.credentialRequirements as Array<Record<string, unknown>>).filter(
          (r) => r['source'] !== 'tenant'
        )
      : [];

    let modelConfig = agentRow.modelConfig as { defaultModel?: string } | null;

    if (raw.credentialId !== null) {
      const cred = await resolveCredentialById(db, effectiveTenantId, raw.credentialId);
      if (!cred) return c.json({ error: 'Credential not found' }, 404);

      const prov = await db.query.provider.findFirst({
        where: eq(providerTable.id, cred.providerId),
      });
      if (!prov) return c.json({ error: 'Credential provider not found' }, 404);
      if (!isInferenceProviderName(prov.plugin)) {
        return c.json({ error: 'Credential must use an inference provider' }, 400);
      }
      const meta = prov.metadata as { model?: string; baseURL?: string } | null;
      if (!meta?.model) {
        return c.json({ error: 'Credential is missing an inference model' }, 400);
      }

      reqs.push({ source: 'tenant', name: cred.name, providerName: prov.name });

      if (!modelConfig?.defaultModel) {
        modelConfig = { defaultModel: meta.model };
      }
    }

    await db
      .update(agent)
      .set({
        credentialRequirements: reqs,
        ...(modelConfig ? { modelConfig } : {}),
        updatedAt: new Date(),
      })
      .where(eq(agent.id, agentId));

    void pushDecryptedSourceUpdates(db, sidecarRouter, effectiveTenantId);

    return c.json({}, 200);
  });

  // Manage tools attached to an agent.
  // Pass tools: string[] to replace the entire list, or add/remove arrays to mutate.
  app.patch('/tenants/:tenantId/agents/:agentId/tools', async (c) => {
    const userId = c.get('userId');
    const tenantId = c.req.param('tenantId');
    const agentId = c.req.param('agentId');

    const raw = await c.req.json().catch(() => null);
    if (!raw || typeof raw !== 'object') {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const hasTools =
      Array.isArray(raw.tools) && raw.tools.every((t: unknown) => typeof t === 'string');
    const hasAdd = Array.isArray(raw.add) && raw.add.every((t: unknown) => typeof t === 'string');
    const hasRemove =
      Array.isArray(raw.remove) && raw.remove.every((t: unknown) => typeof t === 'string');
    if (!hasTools && !hasAdd && !hasRemove) {
      return c.json({ error: 'tools, add, or remove (string array) required' }, 400);
    }

    const callerPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, tenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, userId)
      ),
    });
    if (!callerPrincipal) return c.json({ error: 'Forbidden' }, 403);

    const agentRow = await db.query.agent.findFirst({
      where: and(eq(agent.id, agentId), eq(agent.tenantId, tenantId)),
    });
    if (!agentRow) return c.json({ error: 'Agent not found' }, 404);

    const capabilities = (agentRow.capabilities as Record<string, unknown> | null) ?? {};
    let toolNames: string[];

    if (Array.isArray(raw.tools)) {
      toolNames = raw.tools.filter((t: unknown): t is string => typeof t === 'string');
    } else {
      const current = Array.isArray(capabilities['tools'])
        ? capabilities['tools'].filter((t: unknown): t is string => typeof t === 'string')
        : [];
      const toAdd = Array.isArray(raw.add)
        ? raw.add.filter((t: unknown): t is string => typeof t === 'string')
        : [];
      const toRemove = Array.isArray(raw.remove)
        ? raw.remove.filter((t: unknown): t is string => typeof t === 'string')
        : [];
      const removeSet = new Set(toRemove);
      toolNames = [...new Set([...current, ...toAdd])].filter((t) => !removeSet.has(t));
    }

    const updatedCapabilities: Record<string, unknown> = {
      ...capabilities,
      tools: toolNames,
    };

    await db
      .update(agent)
      .set({
        capabilities: updatedCapabilities,
        updatedAt: new Date(),
      })
      .where(eq(agent.id, agentId));

    await relaunchRunningAgentInstancesForToolUpdate(db, sessionService, grantStore, agentRow);

    return c.json({ tools: toolNames }, 200);
  });

  // List available tools that can be attached to an agent.
  app.get('/tools', async (c) => {
    return c.json({ data: KNOWN_TOOL_NAMES });
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

    // If the agent is already running, no launch is needed — return success immediately.
    // Check this before fetching tenant/agent rows to keep the happy path cheap.
    if (instance.status === 'running') {
      return c.json({ launched: true });
    }

    // Reset a stopped instance so the sidecar treats it as a fresh launch.
    if (instance.status === 'stopped') {
      const resetNow = new Date();
      await db
        .update(agentInstance)
        .set({ status: 'deployed', endedAt: null, updatedAt: resetNow })
        .where(eq(agentInstance.id, instanceId));
      await db
        .update(agent)
        .set({ status: 'deployed', updatedAt: resetNow })
        .where(eq(agent.id, instance.agentId));
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
      await launchAgentSession(db, sessionService, grantStore, {
        agentId: instance.agentId,
        instanceId: instance.id,
        instancePrincipalId: instance.principalId,
        tenantId: instance.tenantId,
        tenantDomain: tenantRow.domain,
        systemPrompt: agentRow.systemPrompt,
        now,
      });
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
        log.error('Failed to launch agent session', { instanceId, error: launchError });
      }
    }

    return c.json({
      launched,
      ...(launchError !== undefined ? { launchError } : {}),
    });
  });

  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────

// Resolves inference sources for every running instance in the tenant, decrypts
// each apiKey (workbench encrypts secrets at write time), and pushes plaintext
// sources to the sidecar. Mirrors the decrypt step in launchAgentSession.
// Errors are logged per-instance and do not propagate.
async function pushDecryptedSourceUpdates(
  db: DB['db'],
  sidecarRouter: SidecarRouter,
  tenantId: string
): Promise<void> {
  const instances = await db.query.agentInstance.findMany({
    where: and(eq(agentInstance.tenantId, tenantId), eq(agentInstance.status, 'running')),
  });

  if (instances.length === 0) return;

  const { credentialKeys } = getConfig();

  const results = await Promise.allSettled(
    instances.map(async (instance) => {
      const rawSources = await resolveInstanceSources(db, tenantId, instance);
      if (rawSources.length === 0) return;
      const sources = rawSources.map((s) => ({
        ...s,
        apiKey: decryptSecret(credentialKeys, tenantId, s.apiKey),
      }));
      const [first] = sources;
      if (first === undefined) return;
      await sidecarRouter.sendSourcesUpdate(instance.address, sources, first.id);
    })
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      log.warn('Failed to push decrypted source update', {
        tenantId,
        reason: String(result.reason),
      });
    }
  }
}

async function relaunchRunningAgentInstancesForToolUpdate(
  db: DB['db'],
  sessionService: SessionService,
  grantStore: GrantStore,
  agentRow: { id: string; tenantId: string; systemPrompt?: string | null }
): Promise<void> {
  if (!agentRow.systemPrompt) return;

  const tenantRow = await db.query.tenant.findFirst({
    where: eq(tenant.id, agentRow.tenantId),
  });
  if (!tenantRow?.domain) return;

  const instances = await db.query.agentInstance.findMany({
    where: and(eq(agentInstance.agentId, agentRow.id), eq(agentInstance.status, 'running')),
  });
  if (instances.length === 0) return;

  const results = await Promise.allSettled(
    instances.map(async (instance) => {
      await sessionService.endSession(instance.address, 'agent tools updated').catch((err) => {
        log.warn('Failed to end running agent before tool relaunch', {
          agentId: agentRow.id,
          instanceId: instance.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      });

      await launchAgentSession(db, sessionService, grantStore, {
        agentId: agentRow.id,
        instanceId: instance.id,
        instancePrincipalId: instance.principalId,
        tenantId: agentRow.tenantId,
        tenantDomain: tenantRow.domain,
        systemPrompt: agentRow.systemPrompt!,
        now: new Date(),
      });
    })
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      log.warn('Failed to relaunch agent after tool update', {
        agentId: agentRow.id,
        tenantId: agentRow.tenantId,
        reason: String(result.reason),
      });
    }
  }
}

async function ensureProvider(
  db: DB['db'],
  tenantId: string,
  name: string,
  plugin: string,
  baseURL: string,
  model: string,
  now: Date
): Promise<string> {
  await db
    .insert(providerTable)
    .values({
      id: generateId('provider'),
      tenantId,
      name,
      plugin,
      metadata: { baseURL, model },
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [providerTable.tenantId, providerTable.name],
      set: { metadata: { baseURL, model }, updatedAt: now },
    });

  const row = await db.query.provider.findFirst({
    where: and(eq(providerTable.tenantId, tenantId), eq(providerTable.name, name)),
  });

  if (!row) throw new Error(`Provider ${name} not found after insert`);
  return row.id;
}

type EnsureAgentResult =
  | {
      instanceId: string;
      agentId: string;
      instancePrincipalId: string;
      address: string;
      isNew: boolean;
    }
  | { error: string; status: 400 | 404 };

async function ensureAgentInstance(
  db: DB['db'],
  opts: {
    tenantId: string;
    tenantDomain: string;
    agentName: string;
    systemPrompt: string;
    creatorPrincipalId: string;
    now: Date;
    credentialIds?: string[];
  }
): Promise<EnsureAgentResult> {
  const {
    tenantId,
    tenantDomain,
    agentName,
    systemPrompt,
    creatorPrincipalId,
    now,
    credentialIds,
  } = opts;

  const agentId = generateId('agent');

  const credReqs: Array<Record<string, unknown>> = [];
  let modelConfig: { defaultModel: string } | undefined;

  if (credentialIds && credentialIds.length > 0) {
    const seenCredentialIds = new Set<string>();
    for (const credId of credentialIds) {
      if (seenCredentialIds.has(credId)) continue;
      seenCredentialIds.add(credId);

      const cred = await resolveCredentialById(db, tenantId, credId);
      if (!cred) {
        return { error: `Credential not found: ${credId}`, status: 404 };
      }

      const prov = await db.query.provider.findFirst({
        where: eq(providerTable.id, cred.providerId),
      });
      if (!prov) {
        return { error: `Credential provider not found for credential: ${credId}`, status: 404 };
      }
      credReqs.push({ source: 'tenant', name: cred.name, providerName: prov.name });

      if (!isInferenceProviderName(prov.plugin)) {
        continue;
      }

      const meta = prov.metadata;
      const model =
        meta && typeof meta === 'object' && 'model' in meta && typeof meta.model === 'string'
          ? meta.model
          : '';
      if (!model) {
        return { error: `Credential is missing an inference model: ${cred.name}`, status: 400 };
      }
      if (modelConfig) {
        return { error: 'Select exactly one inference credential for this agent.', status: 400 };
      }

      modelConfig = { defaultModel: model };
    }
    if (!modelConfig) {
      return { error: 'Select exactly one inference credential for this agent.', status: 400 };
    }
  }

  await db.insert(agent).values({
    id: agentId,
    tenantId,
    creatorPrincipalId,
    name: agentName,
    systemPrompt,
    credentialRequirements: credReqs,
    ...(modelConfig !== undefined ? { modelConfig } : {}),
    status: 'deployed',
    currentVersion: '1',
    createdAt: now,
    updatedAt: now,
  });

  const instancePrincipalId = generateId('principal');
  await db.insert(principal).values({
    id: instancePrincipalId,
    tenantId,
    kind: 'agent',
    refId: agentId,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  const instanceId = generateId('instance');
  const address = `${instanceId}@${tenantDomain}`;

  await db.insert(agentInstance).values({
    id: instanceId,
    agentId,
    tenantId,
    principalId: instancePrincipalId,
    address,
    status: 'deployed',
    createdAt: now,
    updatedAt: now,
  });

  log.info('Agent instance provisioned', { agentName, tenantId, instanceId });
  return { instanceId, agentId, instancePrincipalId, address, isNew: true };
}

async function launchAgentSession(
  db: DB['db'],
  sessionService: SessionService,
  grantStore: GrantStore,
  opts: {
    agentId: string;
    instanceId: string;
    instancePrincipalId: string;
    tenantId: string;
    tenantDomain: string;
    systemPrompt: string;
    now: Date;
  }
): Promise<void> {
  const { agentId, instanceId, instancePrincipalId, tenantId, tenantDomain, systemPrompt, now } =
    opts;
  const address = `${instanceId}@${tenantDomain}`;

  // Repair the agent's credential requirements before resolving — this is the
  // single chokepoint every launch path funnels through, so a definition that
  // predates these fields (e.g. pre-Myra users) is healed here rather than
  // failing to resolve. Loud by design: if repair throws, the launch fails.
  await repairTenantAgentCredentials(db, tenantId);

  const rawSources = await resolveInstanceSources(db, tenantId, {
    agentId,
    sessionId: null,
  });
  if (rawSources.length === 0) {
    throw new Error('No resolvable inference sources for agent credential requirements');
  }

  // Workbench encrypts credential secrets at write time. Interchange returns
  // the raw DB value, so we must decrypt here before the sources reach the sidecar.
  const { credentialKeys } = getConfig();
  const sources = rawSources.map((s) => ({
    ...s,
    apiKey: decryptSecret(credentialKeys, tenantId, s.apiKey),
  }));
  const defaultSource = sources[0]!.id;

  const grants = await grantStore.collectGrants(instancePrincipalId, tenantId);

  const agentRow = await db.query.agent.findFirst({
    where: eq(agent.id, agentId),
  });
  const toolNames = getToolNamesFromCapabilities(agentRow?.capabilities ?? null);
  const tools = buildToolDefinitions(toolNames);

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
      await db
        .update(agentInstance)
        .set({ status: 'running', updatedAt: new Date() })
        .where(eq(agentInstance.id, instanceId));
      log.info('Agent session launched', { instanceId, agentId, tenantId });
      return;
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

  throw lastError;
}

// Relaunch a Myra instance's session if it has no active session but has credentials granted.
// Called from GET /v1/me so existing users get Myra running automatically on login.
export async function relaunchInstanceIfNeeded(
  db: DB['db'],
  sessionService: SessionService,
  grantStore: GrantStore,
  instanceId: string
): Promise<void> {
  const instance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, instanceId),
  });
  if (!instance) return;

  // The instance is live only when its status is "running" — the orchestrator
  // sets this when the agent's session connects. A hub or sidecar restart drops
  // the in-memory agent (the sidecar re-registers "with 0 agents") and leaves
  // the row in "deployed" with a stale "active" session record. Trusting that
  // session record alone meant we never relaunched after a restart, so every
  // /mail POST kept 409ing with "Instance is not running". Gate on the live
  // instance status instead, which is exactly what the mail route checks.
  if (instance.status === 'running') return;

  const tenantRow = await db.query.tenant.findFirst({
    where: eq(tenant.id, instance.tenantId),
  });
  if (!tenantRow?.domain) return;

  const agentRow = await db.query.agent.findFirst({
    where: eq(agent.id, instance.agentId),
  });
  if (!agentRow?.systemPrompt) return;

  // Guard: do not attempt launch if the tenant has no active credential for this agent.
  // Without this check, every GET /v1/me for a pre-onboarding user fires a launch attempt
  // that always fails with "No resolvable inference sources".
  const hasCred = await db.query.credential.findFirst({
    where: and(
      eq(credential.tenantId, instance.tenantId),
      isNull(credential.principalId),
      eq(credential.status, 'active')
    ),
  });
  if (!hasCred) return;

  await launchAgentSession(db, sessionService, grantStore, {
    agentId: instance.agentId,
    instanceId: instance.id,
    instancePrincipalId: instance.principalId,
    tenantId: instance.tenantId,
    tenantDomain: tenantRow.domain,
    systemPrompt: agentRow.systemPrompt,
    now: new Date(),
  });
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
