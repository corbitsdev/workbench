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
import { encryptSecret } from '@workbench/hub-crypto';
import { getConfig } from '../config';

const log = getLogger(['api', 'agents']);

const { agent, agentInstance, agentSession, credential, grant, principal, provider: providerTable, tenant } = intxSchema;

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
  credentialIds: 'string[]>=1',
});

type ProvisionAgentBodyType = typeof ProvisionAgentBody.infer;

const CreateTenantCredentialBody = type({
  provider: LLMProviderType,
  apiKey: 'string',
  model: 'string',
  name: 'string',
  'baseURL?': 'string',
});

const LaunchInstanceSessionBody = type({
  credentialIds: 'string[]>=1',
});

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
          credentialIds: body.credentialIds,
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
            principalId: callerPrincipal.id,
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

        const grants = await db.query.grant.findMany({
          where: and(
            eq(grant.resource, `credential:${cred.id}`),
            eq(grant.tenantId, tenantId)
          ),
        });

        const agentPrincipals = await Promise.all(
          grants
            .filter((g): g is typeof g & { principalId: string } => g.principalId !== null)
            .map((g) =>
              db.query.principal.findFirst({
                where: and(eq(principal.id, g.principalId), eq(principal.kind, 'agent')),
              })
            )
        );
        const agentCount = agentPrincipals.filter(Boolean).length;

        return {
          id: cred.id,
          name: cred.name,
          tenantId: cred.tenantId,
          providerPlugin: prov?.plugin ?? '',
          providerName: prov?.name ?? '',
          status: cred.status,
          agentCount,
          createdAt: cred.createdAt.toISOString(),
          updatedAt: cred.updatedAt.toISOString(),
        };
      })
    );

    return c.json({ data: result });
  });

  // Grant credentials to an agent instance and launch (or relaunch) its session.
  app.post('/instances/:instanceId/sessions', async (c) => {
    const userId = c.get('userId');
    const instanceId = c.req.param('instanceId');

    const raw = await c.req.json().catch(() => null);
    if (!raw) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = LaunchInstanceSessionBody(raw);
    if (parsed instanceof type.errors) {
      return c.json({ error: parsed.summary }, 400);
    }

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

    const credErr = await verifyCredentialsInTenant(db, instance.tenantId, parsed.credentialIds);
    if (credErr) {
      return c.json({ error: credErr }, 422);
    }

    const now = new Date();

    await grantCredentialsToInstance(
      db,
      instance.tenantId,
      instance.principalId,
      parsed.credentialIds,
      now
    );

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
        credentialIds: parsed.credentialIds,
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
    .onConflictDoNothing();

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

// Uses Interchange's resolveCredentialById which walks the tenant ancestor chain.
async function verifyCredentialsInTenant(
  db: DB['db'],
  tenantId: string,
  credentialIds: string[]
): Promise<string | null> {
  for (const id of credentialIds) {
    const row = await resolveCredentialById(db, tenantId, id);
    if (!row) return `Credential not found in tenant or its ancestors: ${id}`;
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
  const sources: InferenceSource[] = [];
  for (const credId of credentialIds) {
    const cred = await resolveCredentialById(db, tenantId, credId);
    if (!cred) continue;
    const prov = await db.query.provider.findFirst({ where: eq(providerTable.id, cred.providerId) });
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

  // Already has an active session record — sidecar will restore it on reconnect.
  if (instance.sessionId) {
    const session = await db.query.agentSession.findFirst({
      where: eq(agentSession.id, instance.sessionId),
    });
    if (session?.status === 'active') return;
  }

  const tenantRow = await db.query.tenant.findFirst({
    where: eq(tenant.id, instance.tenantId),
  });
  if (!tenantRow?.domain) return;

  const agentRow = await db.query.agent.findFirst({
    where: eq(agent.id, instance.agentId),
  });
  if (!agentRow?.systemPrompt) return;

  // Find credentials already granted to this instance.
  const credentialGrants = await db.query.grant.findMany({
    where: and(
      eq(grant.principalId, instance.principalId),
      eq(grant.tenantId, instance.tenantId)
    ),
  });

  const credentialIds = credentialGrants
    .map((g) => {
      const match = /^credential:(.+)$/.exec(g.resource);
      return match?.[1] ?? null;
    })
    .filter((id): id is string => id !== null);

  if (credentialIds.length === 0) return;

  await launchAgentSession(db, sessionService, grantStore, {
    agentId: instance.agentId,
    instanceId: instance.id,
    instancePrincipalId: instance.principalId,
    tenantId: instance.tenantId,
    tenantDomain: tenantRow.domain,
    systemPrompt: agentRow.systemPrompt,
    credentialIds,
    now: new Date(),
  });
}
