import { and, eq } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import { generateId } from '@intx/hub-common';
import { AGENT_TEMPLATES, PERSONAL_AGENT_NAME } from '@workbench/agents';
import type { SessionService, EventCollectorRegistry } from '@intx/hub-sessions';
import type { GrantStore } from '@intx/types/authz';
import { memberAgentInstance } from '../db/schema';
import type { HubDb } from '../db';
import { getConfig } from '../config';
import { lookupGlobalMember } from '../lib/tenant-provisioning';
import { launchAgentSession } from './agent-provisioning';
import { getLogger } from '@intx/log';

const log = getLogger(['api', 'myra-threads']);

const { agent, agentInstance, principal, grant } = intxSchema;

export const MYRA_TEMPLATE_KEY = 'myra';

export type MyraThreadRow = {
  id: string;
  instanceId: string;
  label: string;
  createdAt: string;
};

function defaultThreadLabel(index: number): string {
  if (index === 0) return 'Chat';
  return `Chat ${index + 1}`;
}

export async function listMyraThreads(
  db: HubDb,
  opts: { tenantId: string; memberPrincipalId: string }
): Promise<MyraThreadRow[]> {
  const rows = await db.query.memberAgentInstance.findMany({
    where: and(
      eq(memberAgentInstance.tenantId, opts.tenantId),
      eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
      eq(memberAgentInstance.templateKey, MYRA_TEMPLATE_KEY)
    ),
    orderBy: [memberAgentInstance.createdAt],
  });

  return rows.map((row, index) => ({
    id: row.id,
    instanceId: row.instanceId,
    label: row.label?.trim() || defaultThreadLabel(index),
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function createMyraThread(
  db: HubDb,
  deps: {
    sessionService: SessionService;
    grantStore: GrantStore;
    eventCollectors: EventCollectorRegistry;
  },
  opts: {
    tenantId: string;
    tenantDomain: string;
    memberPrincipalId: string;
    label?: string;
  }
): Promise<{ thread: MyraThreadRow; created: true }> {
  const template = AGENT_TEMPLATES.find((t) => t.key === MYRA_TEMPLATE_KEY);
  if (!template) {
    throw new Error('Myra template is not registered');
  }

  const def = await db.query.agent.findFirst({
    where: and(eq(agent.tenantId, opts.tenantId), eq(agent.name, PERSONAL_AGENT_NAME)),
  });
  if (!def) {
    throw new Error('Myra org definition is not seeded for this tenant');
  }

  const now = new Date();
  const instanceId = generateId('instance');
  let instancePrincipalId = '';

  const existingCount = await db.query.memberAgentInstance.findMany({
    where: and(
      eq(memberAgentInstance.tenantId, opts.tenantId),
      eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
      eq(memberAgentInstance.templateKey, MYRA_TEMPLATE_KEY)
    ),
  });

  const label = opts.label?.trim() || defaultThreadLabel(existingCount.length);

  const mappingId = generateId('instance');

  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as HubDb;
    const newPrincipalId = generateId('principal');
    await tx.insert(principal).values({
      id: newPrincipalId,
      tenantId: opts.tenantId,
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
      tenantId: opts.tenantId,
      principalId: instancePrincipalId,
      address: `${instanceId}@${opts.tenantDomain}`,
      status: 'deployed',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(memberAgentInstance).values({
      id: mappingId,
      tenantId: opts.tenantId,
      memberPrincipalId: opts.memberPrincipalId,
      templateKey: MYRA_TEMPLATE_KEY,
      agentId: def.id,
      instanceId,
      label,
      createdAt: now,
    });

    for (const action of ['read', 'write', 'manage'] as const) {
      await tx.insert(grant).values({
        id: generateId('grant'),
        tenantId: opts.tenantId,
        principalId: opts.memberPrincipalId,
        resource: `instance:${instanceId}`,
        action,
        effect: 'allow',
        origin: 'system',
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  try {
    await launchAgentSession(db, deps.sessionService, deps.grantStore, deps.eventCollectors, {
      agentId: def.id,
      instanceId,
      instancePrincipalId,
      tenantId: opts.tenantId,
      tenantDomain: opts.tenantDomain,
      systemPrompt: def.systemPrompt ?? '',
      now,
    });
  } catch (err) {
    log.warn('Myra thread instance created but session launch failed', {
      instanceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    created: true,
    thread: {
      id: mappingId,
      instanceId,
      label,
      createdAt: now.toISOString(),
    },
  };
}

export async function renameMyraThread(
  db: HubDb,
  opts: { tenantId: string; memberPrincipalId: string; threadId: string; label: string }
): Promise<MyraThreadRow | null> {
  const label = opts.label.trim();
  if (!label) return null;

  const updated = await db
    .update(memberAgentInstance)
    .set({ label })
    .where(
      and(
        eq(memberAgentInstance.id, opts.threadId),
        eq(memberAgentInstance.tenantId, opts.tenantId),
        eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
        eq(memberAgentInstance.templateKey, MYRA_TEMPLATE_KEY)
      )
    )
    .returning();

  const row = updated[0];
  if (!row) return null;

  return {
    id: row.id,
    instanceId: row.instanceId,
    label: row.label?.trim() || label,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function deleteMyraThread(
  db: HubDb,
  deps: { sessionService: SessionService },
  opts: { tenantId: string; memberPrincipalId: string; threadId: string }
): Promise<boolean> {
  const mapping = await db.query.memberAgentInstance.findFirst({
    where: and(
      eq(memberAgentInstance.id, opts.threadId),
      eq(memberAgentInstance.tenantId, opts.tenantId),
      eq(memberAgentInstance.memberPrincipalId, opts.memberPrincipalId),
      eq(memberAgentInstance.templateKey, MYRA_TEMPLATE_KEY)
    ),
  });
  if (!mapping) return false;

  const { instanceId } = mapping;

  const instance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, instanceId),
  });

  if (instance?.address) {
    try {
      await deps.sessionService.endSession(instance.address, 'myra_thread_deleted');
    } catch (err) {
      log.warn('Failed to end Myra thread session before delete; leaving to reconciler', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as HubDb;
    await tx.delete(grant).where(eq(grant.resource, `instance:${instanceId}`));
    await tx.delete(memberAgentInstance).where(eq(memberAgentInstance.id, opts.threadId));
    await tx.delete(agentInstance).where(eq(agentInstance.id, instanceId));
    await tx
      .delete(principal)
      .where(and(eq(principal.refId, instanceId), eq(principal.kind, 'agent')));
  });

  return true;
}

export async function resolveMyraThreadContext(
  db: HubDb,
  userId: string
): Promise<{ tenantId: string; tenantDomain: string; memberPrincipalId: string } | null> {
  const { domain } = getConfig().globalTenant;
  const member = await lookupGlobalMember(db as never, { userId });
  if (!member) return null;
  return {
    tenantId: member.tenantId,
    tenantDomain: domain,
    memberPrincipalId: member.principalId,
  };
}
