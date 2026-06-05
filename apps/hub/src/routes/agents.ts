import { eq, and, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { generateId } from '@intx/hub-common';
import { getLogger } from '@intx/log';
import { type } from 'arktype';
import { PERSONAL_AGENT_DEPLOY_PROMPT } from '../lib/tenant-provisioning';
import { decryptSecret, encryptSecret } from '@workbench/hub-crypto';
import { getConfig } from '../config';

const log = getLogger(['api', 'agents']);

const {
  agent,
  agentInstance,
  credential,
  grant,
  provider,
  principal,
  tenant,
  principalRole,
  role,
} = intxSchema;

// ─── Request shapes ────────────────────────────────────────────────

const LLMProviderInput = type({
  baseURL: 'string',
  apiKey: 'string',
  model: 'string',
});

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

const ProvisionOatBody = type({
  type: '"oat"',
  scope: '"workspace"',
  tenantId: 'string',
  credentialIds: 'string[]>=1',
});

const ProvisionMyraBody = type({
  type: '"myra"',
  scope: '"personal"',
  tenantId: 'string',
  llm: LLMProviderInput,
});

const ProvisionAgentBody = ProvisionOatBody.or(ProvisionMyraBody);

type ProvisionOatBodyType = typeof ProvisionOatBody.infer;
type ProvisionMyraBodyType = typeof ProvisionMyraBody.infer;
type ProvisionAgentBodyType = ProvisionOatBodyType | ProvisionMyraBodyType;

// ─── Route ────────────────────────────────────────────────────────

export function createAgentProvisioningRouter(
  db: DB['db']
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

  // Provision an agent with its required credentials
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

    // Resolve the creator principal for this tenant
    const creatorPrincipal = await db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, body.tenantId),
        eq(principal.kind, 'user'),
        eq(principal.refId, userId)
      ),
    });

    if (!creatorPrincipal) {
      return c.json({ error: 'No principal found for this tenant' }, 403);
    }

    const tenantRow = await db.query.tenant.findFirst({
      where: eq(tenant.id, body.tenantId),
    });

    if (!tenantRow) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    const now = new Date();

    if (body.type === 'oat') {
      // Workspace agents require owner or admin role
      const isAdmin = await callerHasAdminRole(db, creatorPrincipal.id);
      if (!isAdmin) {
        return c.json(
          { error: 'Only workspace owners and admins can provision workspace agents' },
          403
        );
      }
      const result = await provisionOat(db, body, creatorPrincipal.id, tenantRow.domain, now);
      return c.json(result, 201);
    }

    const result = await provisionMyra(db, body, creatorPrincipal.id, tenantRow.domain, now);
    return c.json(result, 201);
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

    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB['db'];

      const llmProviderId = await ensureProvider(
        tx,
        personalTenant.id,
        'openai-compatible',
        parsed.provider,
        baseURL,
        parsed.model,
        now
      );

      await ensureCredential(
        tx,
        personalTenant.id,
        `myra-llm-${callerPrincipal.id}`,
        parsed.apiKey,
        llmProviderId,
        callerPrincipal.id,
        now
      );
    });

    log.info('Myra credential configured for user {userId}', { userId });
    return c.json({ ok: true });
  });

  return app;
}

async function callerHasAdminRole(db: DB['db'], principalId: string): Promise<boolean> {
  const rows = await db
    .select({ roleName: role.name })
    .from(principalRole)
    .innerJoin(role, eq(principalRole.roleId, role.id))
    .where(eq(principalRole.principalId, principalId));

  return rows.some((r) => r.roleName === 'owner' || r.roleName === 'admin');
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

async function ensureAgentInstance(
  db: DB['db'],
  opts: {
    tenantId: string;
    tenantDomain: string;
    agentName: string;
    systemPrompt: string;
    credentialRequirements: Array<{ providerName: string; source: string }>;
    creatorPrincipalId: string;
    now: Date;
  }
): Promise<{ instanceId: string; agentId: string; instancePrincipalId: string }> {
  const {
    tenantId,
    tenantDomain,
    agentName,
    systemPrompt,
    credentialRequirements,
    creatorPrincipalId,
    now,
  } = opts;

  const existingAgent = await db.query.agent.findFirst({
    where: and(eq(agent.tenantId, tenantId), eq(agent.name, agentName)),
  });

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
      credentialRequirements,
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
  return { instanceId, agentId, instancePrincipalId };
}

const OAT_DEPLOY_PROMPT =
  'You are Oat, a shared workspace agent that helps analyze customer calls and generate GTM collateral. Be concise, structured, and professional.';

async function verifyCredentialsInTenant(
  db: DB['db'],
  tenantId: string,
  credentialIds: string[]
): Promise<void> {
  const rows = await db.query.credential.findMany({
    where: and(eq(credential.tenantId, tenantId), inArray(credential.id, credentialIds)),
  });
  if (rows.length !== credentialIds.length) {
    throw new Error('One or more credentials not found in tenant');
  }
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

async function provisionOat(
  db: DB['db'],
  body: ProvisionOatBodyType,
  creatorPrincipalId: string,
  tenantDomain: string,
  now: Date
) {
  const { tenantId, credentialIds } = body;

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB['db'];
    await verifyCredentialsInTenant(tx, tenantId, credentialIds);

    const { instanceId, agentId, instancePrincipalId } = await ensureAgentInstance(tx, {
      tenantId,
      tenantDomain,
      agentName: 'Oat',
      systemPrompt: OAT_DEPLOY_PROMPT,
      credentialRequirements: [
        { providerName: 'granola', source: 'tenant' },
        { providerName: 'openai-compatible', source: 'tenant' },
      ],
      creatorPrincipalId,
      now,
    });

    await grantCredentialsToInstance(tx, tenantId, instancePrincipalId, credentialIds, now);

    return { instanceId, agentId, agentName: 'Oat', tenantId };
  });
}

async function provisionMyra(
  db: DB['db'],
  body: ProvisionMyraBodyType,
  creatorPrincipalId: string,
  tenantDomain: string,
  now: Date
) {
  const { tenantId, llm } = body;

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB['db'];
    const llmProviderId = await ensureProvider(
      tx,
      tenantId,
      'openai-compatible',
      'openai-compatible',
      llm.baseURL,
      llm.model,
      now
    );
    await ensureCredential(
      tx,
      tenantId,
      `myra-llm-${creatorPrincipalId}`,
      llm.apiKey,
      llmProviderId,
      creatorPrincipalId,
      now
    );

    const { instanceId, agentId } = await ensureAgentInstance(tx, {
      tenantId,
      tenantDomain,
      agentName: `myra-${creatorPrincipalId}`,
      systemPrompt: PERSONAL_AGENT_DEPLOY_PROMPT,
      credentialRequirements: [{ providerName: 'openai-compatible', source: 'invoker' }],
      creatorPrincipalId,
      now,
    });

    return { instanceId, agentId, agentName: 'Myra', tenantId };
  });
}
