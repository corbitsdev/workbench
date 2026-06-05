import { eq, and, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema as intxSchema } from '@intx/db';
import { resolveCredentialById } from '@intx/db';
import type { DB } from '@intx/db';
import { generateId } from '@intx/hub-common';
import { getLogger } from '@intx/log';
import type { SessionService } from '@intx/hub-sessions';
import type { GrantStore } from '@intx/types/authz';
import type { InferenceSource } from '@intx/types/runtime';
import { type } from 'arktype';
import { decryptSecret, encryptSecret } from '@workbench/hub-crypto';
import { getConfig } from '../config';

const log = getLogger(['api', 'agents']);

const { agent, agentInstance, agentSession, credential, grant, principal, tenant } = intxSchema;

// ─── Request shapes ────────────────────────────────────────────────

const LLMProviderType = type('"anthropic" | "openai" | "google-genai" | "openai-compatible"');
type LLMProviderTypeType = typeof LLMProviderType.infer;

const PROVIDER_BASE_URLS: Record<LLMProviderTypeType, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  'google-genai': 'https://generativelanguage.googleapis.com',
  'openai-compatible': '',
};

const SetupMyraCredentialBody = type({
  provider: LLMProviderType,
  apiKey: 'string',
  model: 'string',
  'baseURL?': 'string',
});

const ProvisionAgentBody = type({
  tenantId: 'string',
  name: 'string',
  systemPrompt: 'string',
  credentialIds: 'string[]>=1',
});

type ProvisionAgentBodyType = typeof ProvisionAgentBody.infer;

// ─── Route ────────────────────────────────────────────────────────

export function createAgentProvisioningRouter(
  db: DB['db'],
  sessionService: SessionService,
  grantStore: GrantStore
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

    const result = instances.map((inst) => ({
      id: inst.id,
      agentId: inst.agentId,
      agentName: agentMap.get(inst.agentId)?.name ?? 'Unknown',
      tenantId: inst.tenantId,
      address: inst.address,
      status: inst.status,
      createdAt: inst.createdAt.toISOString(),
    }));

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

    const credentialError = await verifyCredentialsInTenant(db, body.tenantId, body.credentialIds);
    if (credentialError) {
      return c.json({ error: credentialError }, 422);
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

      await grantCredentialsToInstance(
        tx,
        body.tenantId,
        provisionResult.instancePrincipalId,
        body.credentialIds,
        now
      );

      return provisionResult;
    });

    if ('conflict' in txResult) {
      return c.json({ error: txResult.conflict }, 409);
    }

    const { instanceId, agentId, instancePrincipalId, isNew } = txResult;

    if (isNew) {
      try {
        await launchAgentSession(db, sessionService, grantStore, {
          agentId,
          instanceId,
          instancePrincipalId,
          tenantId: body.tenantId,
          tenantDomain: tenantRow.domain,
          systemPrompt: body.systemPrompt,
          credentialIds: body.credentialIds,
          now,
        });
      } catch (err) {
        log.error('Failed to launch agent session after provisioning', {
          instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({ instanceId, agentId, agentName: body.name, tenantId: body.tenantId }, 201);
  });

  // Configure or update the LLM credential for the caller's Myra instance
  app.post('/myra/credential', async (c) => {
    const userId = c.get('userId');
    const raw = await c.req.json().catch(() => null);
    if (!raw) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = SetupMyraCredentialBody(raw);
    if (parsed instanceof type.errors) {
      return c.json({ error: parsed.summary }, 400);
    }

    const personalTenant = await db.query.tenant.findFirst({
      where: eq(tenant.slug, `user-${userId}`),
    });
    if (!personalTenant) {
      return c.json({ error: 'Personal tenant not found' }, 404);
    }

    if (!personalTenant.domain) {
      return c.json({ error: 'Personal tenant has no domain configured' }, 500);
    }

    const callerPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, personalTenant.id),
        eq(principal.kind, 'user'),
        eq(principal.refId, userId)
      ),
    });
    if (!callerPrincipal) {
      return c.json({ error: 'Principal not found in personal tenant' }, 404);
    }

    const baseURL =
      parsed.provider === 'openai-compatible'
        ? (parsed.baseURL ?? '')
        : PROVIDER_BASE_URLS[parsed.provider];

    const now = new Date();

    let credentialId: string;
    let providerId: string;

    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB['db'];

      providerId = await ensureProvider(
        tx,
        personalTenant.id,
        'openai-compatible',
        parsed.provider,
        baseURL,
        parsed.model,
        now
      );

      credentialId = await ensureCredential(
        tx,
        personalTenant.id,
        `myra-llm-${callerPrincipal.id}`,
        parsed.apiKey,
        providerId,
        callerPrincipal.id,
        now
      );
    });

    const myraInstance = await db.query.agentInstance.findFirst({
      where: and(
        eq(agentInstance.tenantId, personalTenant.id),
        inArray(agentInstance.status, ['deployed', 'running'])
      ),
    });

    if (myraInstance) {
      const myraAgentRow = await db.query.agent.findFirst({
        where: eq(agent.id, myraInstance.agentId),
      });
      const systemPrompt = myraAgentRow?.systemPrompt;

      if (systemPrompt) {
        await grantCredentialsToInstance(
          db,
          personalTenant.id,
          myraInstance.principalId,
          [credentialId!],
          now
        );
        try {
          await launchAgentSession(db, sessionService, grantStore, {
            agentId: myraInstance.agentId,
            instanceId: myraInstance.id,
            instancePrincipalId: myraInstance.principalId,
            tenantId: personalTenant.id,
            tenantDomain: personalTenant.domain,
            systemPrompt,
            credentialIds: [credentialId!],
            now,
          });
        } catch (err) {
          log.error('Failed to launch Myra session after credential setup', {
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    log.info('Myra credential configured for user {userId}', { userId });
    return c.json({ ok: true });
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
  const { provider } = intxSchema;

  await db
    .insert(provider)
    .values({
      id: generateId('provider'),
      tenantId,
      name,
      plugin,
      metadata: { baseURL, model },
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const row = await db.query.provider.findFirst({
    where: and(eq(provider.tenantId, tenantId), eq(provider.name, name)),
  });

  if (!row) throw new Error(`Provider ${name} not found after insert`);
  return row.id;
}

async function ensureCredential(
  db: DB['db'],
  tenantId: string,
  name: string,
  secret: string,
  providerId: string,
  principalId: string | null,
  now: Date
): Promise<string> {
  const { credentialKeys } = getConfig();
  const encryptedSecret = encryptSecret(credentialKeys, tenantId, secret);

  await db
    .insert(credential)
    .values({
      id: generateId('credential'),
      tenantId,
      providerId,
      principalId,
      name,
      type: 'api_key',
      secret: encryptedSecret,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const row = await db.query.credential.findFirst({
    where: and(eq(credential.tenantId, tenantId), eq(credential.name, name)),
  });

  if (!row) throw new Error(`Credential ${name} not found after insert`);

  // Legacy rows written before encryption was introduced have no enc: prefix.
  // Detect and re-encrypt them on next touch; log so operators can track migration progress.
  const isLegacy = !row.secret.startsWith('enc:');
  if (isLegacy) {
    log.warn('Re-encrypting legacy plaintext credential {name} for tenant {tenantId}', {
      name,
      tenantId,
    });
  }
  const storedPlaintext = isLegacy ? row.secret : decryptSecret(credentialKeys, tenantId, row.secret);
  if (storedPlaintext !== secret) {
    await db
      .update(credential)
      .set({ secret: encryptedSecret, updatedAt: now })
      .where(eq(credential.id, row.id));
  }

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
    await db.insert(agent).values({
      id: agentId,
      tenantId,
      creatorPrincipalId,
      name: agentName,
      systemPrompt,
      credentialRequirements: [],
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

async function verifyCredentialsInTenant(
  db: DB['db'],
  tenantId: string,
  credentialIds: string[]
): Promise<string | null> {
  const rows = await db.query.credential.findMany({
    where: and(eq(credential.tenantId, tenantId), inArray(credential.id, credentialIds)),
  });
  if (rows.length !== credentialIds.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = credentialIds.filter((id) => !found.has(id));
    return `Credentials not found in tenant: ${missing.join(', ')}`;
  }
  return null;
}

async function grantCredentialsToInstance(
  db: DB['db'],
  tenantId: string,
  instancePrincipalId: string,
  credentialIds: string[],
  now: Date
): Promise<void> {
  for (const credentialId of credentialIds) {
    await db
      .insert(grant)
      .values({
        id: generateId('grant'),
        tenantId,
        principalId: instancePrincipalId,
        resource: `credential:${credentialId}`,
        action: '*',
        effect: 'allow',
        origin: 'creator',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}

async function buildSourcesFromCredentialIds(
  db: DB['db'],
  tenantId: string,
  credentialIds: string[]
): Promise<InferenceSource[]> {
  const { provider } = intxSchema;
  const sources: InferenceSource[] = [];
  for (const credId of credentialIds) {
    const cred = await resolveCredentialById(db, tenantId, credId);
    if (!cred) continue;
    const prov = await db.query.provider.findFirst({ where: eq(provider.id, cred.providerId) });
    if (!prov) continue;
    const meta = prov.metadata as { baseURL?: string; model?: string } | null;
    if (!meta?.baseURL || !meta?.model) continue;
    sources.push({
      id: `${prov.plugin}:${meta.model}`,
      provider: prov.plugin,
      baseURL: meta.baseURL,
      apiKey: cred.secret,
      model: meta.model,
    });
  }
  return sources;
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
    credentialIds: string[];
    now: Date;
  }
): Promise<void> {
  const {
    agentId,
    instanceId,
    instancePrincipalId,
    tenantId,
    tenantDomain,
    systemPrompt,
    credentialIds,
    now,
  } = opts;
  const address = `${instanceId}@${tenantDomain}`;

  const sources = await buildSourcesFromCredentialIds(db, tenantId, credentialIds);
  if (sources.length === 0) {
    throw new Error('No resolvable inference sources for the provided credentials');
  }
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

  await sessionService.launchSession({
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
  });

  log.info('Agent session launched', { instanceId, agentId, tenantId });
}
