import { eq, and, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema as intxSchema, resolveInstanceSources } from '@intx/db';
import type { DB } from '@intx/db';
import { generateId } from '@intx/hub-common';
import { getLogger } from '@intx/log';
import type { SessionService, SidecarRouter } from '@intx/hub-sessions';
import { pushSourceUpdates } from '@intx/hub-sessions';
import type { GrantStore } from '@intx/types/authz';
import { type } from 'arktype';
import { encryptSecret, decryptSecret } from '@workbench/hub-crypto';
import { getConfig } from '../config';
import { repairTenantAgentCredentials } from '../lib/agent-credential-repair';

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

const LLMProviderType = type('"anthropic" | "openai" | "google-genai" | "openai-compatible"');
type LLMProviderTypeType = typeof LLMProviderType.infer;

const PROVIDER_BASE_URLS: Record<LLMProviderTypeType, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  'google-genai': 'https://generativelanguage.googleapis.com',
  'openai-compatible': '',
};

const ProvisionAgentBody = type({
  tenantId: 'string',
  name: 'string',
  systemPrompt: 'string',
});

type ProvisionAgentBodyType = typeof ProvisionAgentBody.infer;

const CreateTenantCredentialBody = type({
  provider: LLMProviderType,
  apiKey: 'string',
  model: 'string',
  name: 'string',
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
        inArray(agentInstance.status, ['deployed', 'running'])
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
        createdAt: inst.createdAt.toISOString(),
      };
    });

    return c.json({ data: result });
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

      const provisionResult = await ensureAgentInstance(tx, {
        tenantId: body.tenantId,
        tenantDomain: tenantRow.domain,
        agentName: body.name,
        systemPrompt: body.systemPrompt,
        creatorPrincipalId: callerPrincipal.id,
        now,
      });

      if ('conflict' in provisionResult) {
        return provisionResult;
      }

      return provisionResult;
    });

    if ('conflict' in txResult) {
      return c.json({ error: txResult.conflict }, 409);
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

    const baseURL =
      parsed.provider === 'openai-compatible'
        ? (parsed.baseURL ?? '')
        : PROVIDER_BASE_URLS[parsed.provider];

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
          parsed.provider,
          parsed.provider,
          baseURL,
          parsed.model,
          now
        );

        // Encrypt secret before storage — Interchange stores plaintext; encryption is a workbench
        // invariant applied at the write boundary.
        const encryptedSecret = encryptSecret(getConfig().credentialKeys, tenantId, parsed.apiKey);

        const [inserted] = await tx
          .insert(credential)
          .values({
            id: generateId('credential'),
            tenantId,
            providerId,
            principalId: null,
            name: parsed.name,
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
            new Error(`Credential named '${parsed.name}' already exists in this tenant`),
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

    void pushSourceUpdates(db, sidecarRouter, tenantId);

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

    const credentials = await db.query.credential.findMany({
      where: eq(credential.tenantId, tenantId),
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
              baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim() : (existingMeta.baseURL ?? ''),
              model: typeof raw.model === 'string' ? raw.model.trim() : (existingMeta.model ?? ''),
            },
            updatedAt: now,
          })
          .where(eq(providerTable.id, cred.providerId));
      }
    });

    void pushSourceUpdates(db, sidecarRouter, tenantId);

    return c.json({ credentialId }, 200);
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
      launchError = err instanceof Error ? err.message : String(err);
      log.error('Failed to launch agent session', { instanceId, error: launchError });
    }

    return c.json({
      launched,
      ...(launchError !== undefined ? { launchError } : {}),
    });
  });

  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────

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
  | { conflict: string };

async function ensureAgentInstance(
  db: DB['db'],
  opts: {
    tenantId: string;
    tenantDomain: string;
    agentName: string;
    systemPrompt: string;
    creatorPrincipalId: string;
    now: Date;
  }
): Promise<EnsureAgentResult> {
  const { tenantId, tenantDomain, agentName, systemPrompt, creatorPrincipalId, now } = opts;

  const existingAgent = await db.query.agent.findFirst({
    where: and(eq(agent.tenantId, tenantId), eq(agent.name, agentName)),
  });

  if (existingAgent && existingAgent.systemPrompt !== systemPrompt) {
    return {
      conflict: `An agent named "${agentName}" already exists with a different system prompt. Choose a different name or update the existing agent.`,
    };
  }

  let agentId: string;
  if (existingAgent) {
    agentId = existingAgent.id;
  } else {
    agentId = generateId('agent');

    // Resolve the tenant credential named 'Myra LLM' eagerly so we can populate
    // providerName (required by resolveCredentialRequirement) and modelConfig at
    // definition time. If the credential does not exist yet, these will be filled
    // in when the credential is created via POST /tenants/:tenantId/credentials.
    const existingCred = await db.query.credential.findFirst({
      where: and(
        eq(credential.tenantId, tenantId),
        eq(credential.name, 'Myra LLM'),
        isNull(credential.principalId),
        eq(credential.status, 'active')
      ),
    });
    let credReqs: Array<Record<string, unknown>>;
    let modelConfig: { defaultModel: string } | undefined;
    if (existingCred) {
      const prov = await db.query.provider.findFirst({
        where: eq(providerTable.id, existingCred.providerId),
      });
      const meta = prov?.metadata as { model?: string } | null;
      credReqs = [{ source: 'tenant', name: 'Myra LLM', providerName: prov?.name ?? '' }];
      modelConfig = meta?.model ? { defaultModel: meta.model } : undefined;
    } else {
      credReqs = [];
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
  }

  const existingInstance = await db.query.agentInstance.findFirst({
    where: and(
      eq(agentInstance.agentId, agentId),
      inArray(agentInstance.status, ['deployed', 'running'])
    ),
  });
  if (existingInstance) {
    return {
      instanceId: existingInstance.id,
      agentId,
      instancePrincipalId: existingInstance.principalId,
      address: existingInstance.address,
      isNew: false,
    };
  }

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

function decryptSources<T extends { apiKey?: string }>(sources: T[], tenantId: string): T[] {
  const keys = getConfig().credentialKeys;
  return sources.map((s) => {
    if (!s.apiKey?.startsWith('enc:')) return s;
    return { ...s, apiKey: decryptSecret(keys, tenantId, s.apiKey) };
  });
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
  const sources = decryptSources(rawSources, tenantId);
  const defaultSource = sources[0]!.id;

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

  const grants = await grantStore.collectGrants(instancePrincipalId, tenantId);

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
      tools: [],
      grants,
      sources,
      defaultSource,
    },
    deployContent: { systemPrompt },
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_LAUNCH_ATTEMPTS; attempt++) {
    try {
      await sessionService.launchSession(launchConfig);
      log.info('Agent session launched', { instanceId, agentId, tenantId });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_LAUNCH_ATTEMPTS - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, LAUNCH_RETRY_DELAY_MS));
      }
    }
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
