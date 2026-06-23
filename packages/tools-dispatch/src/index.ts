import { generateId } from '@intx/hub-common';
import { getLogger } from '@intx/log';
import { schema as intxSchema, resolveInstanceModelSources, createGrantStore } from '@intx/db';
import type { DB } from '@intx/db';
import { generateKeyPair, createNodeCrypto } from '@intx/crypto-node';
import type { SessionService, EventCollectorRegistry, SidecarRouter } from '@intx/hub-sessions';
import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';

export type { ToolDefinition };
import { and, eq } from 'drizzle-orm';
import { DISPATCH_AGENT_DEFINITION } from './definition';

export { DISPATCH_AGENT_DEFINITION };

const log = getLogger(['tools', 'dispatch']);

export type DispatchContext = {
  db: DB['db'];
  tenantId: string;
  principalId: string;
  agentId: string;
  sessionId: string;
  sessionService: SessionService;
  eventCollectors: EventCollectorRegistry;
  sidecarRouter: SidecarRouter;
  buildToolDefinitions: (names: string[]) => ToolDefinition[];
};

/**
 * Build and persist tool grant rows for an instance principal.
 * Copied from apps/hub/src/lib/tool-grants.ts to keep the package self-contained.
 */
function persistToolGrants(
  db: DB['db'],
  toolNames: string[],
  scope: { tenantId: string; principalId: string },
  now: Date
): Promise<void> {
  const unique = [...new Set(toolNames)];
  if (unique.length === 0) return Promise.resolve();

  const rows = unique.map((name) => ({
    id: generateId('grant'),
    tenantId: scope.tenantId,
    principalId: scope.principalId,
    roleId: null as string | null,
    resource: `tool:${name}`,
    action: 'invoke',
    effect: 'allow' as const,
    conditions: null as Record<string, unknown> | null,
    origin: 'system' as const,
    expiresAt: null as Date | null,
    createdAt: now,
    updatedAt: now,
  }));

  return db.transaction(async (tx) => {
    await tx
      .delete(intxSchema.grant)
      .where(
        and(
          eq(intxSchema.grant.principalId, scope.principalId),
          eq(intxSchema.grant.origin, 'system')
        )
      );
    await tx.insert(intxSchema.grant).values(rows);
  });
}

function getToolNamesFromCapabilities(capabilities: unknown): string[] {
  if (typeof capabilities !== 'object' || capabilities === null) return [];
  const tools = (capabilities as Record<string, unknown>)['tools'];
  if (!Array.isArray(tools)) return [];
  return tools.filter((t): t is string => typeof t === 'string');
}

async function launchAgentInstance(
  context: DispatchContext,
  agentRow: typeof intxSchema.agent.$inferSelect
): Promise<{ instanceId: string; address: string; sessionId: string }> {
  const { db, tenantId, sessionService, eventCollectors } = context;
  const agentDefinitionId = agentRow.id;
  const systemPrompt = agentRow.systemPrompt!;

  const tenantRow = await db.query.tenant.findFirst({
    where: eq(intxSchema.tenant.id, tenantId),
  });
  if (!tenantRow?.domain) {
    throw new Error('Tenant has no domain configured');
  }

  const now = new Date();
  const instancePrincipalId = generateId('principal');
  const instanceId = generateId('instance');
  const address = `${instanceId}@${tenantRow.domain}`;

  await db.transaction(async (tx) => {
    await tx.insert(intxSchema.principal).values({
      id: instancePrincipalId,
      tenantId,
      kind: 'agent',
      refId: agentDefinitionId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(intxSchema.agentInstance).values({
      id: instanceId,
      agentId: agentDefinitionId,
      tenantId,
      principalId: instancePrincipalId,
      address,
      status: 'deployed',
      createdAt: now,
      updatedAt: now,
    });
  });

  const grantStore = createGrantStore(db);

  const resolution = await resolveInstanceModelSources(db, tenantId, {
    agentId: agentDefinitionId,
    modelPreferences: null,
  });
  if (!resolution.ok) {
    throw new Error(
      'No resolvable inference sources for agent credential requirements: ' + resolution.reason
    );
  }

  const sources = resolution.sources;
  const defaultSource = sources[0]!.id;

  const toolNames = getToolNamesFromCapabilities(agentRow.capabilities ?? null);
  const tools = context.buildToolDefinitions(toolNames);
  await persistToolGrants(db, toolNames, { tenantId, principalId: instancePrincipalId }, now);

  const grants = await grantStore.collectGrants(instancePrincipalId, tenantId);

  const sessionId = generateId('session');
  await db.transaction(async (tx) => {
    await tx.insert(intxSchema.agentSession).values({
      id: sessionId,
      tenantId,
      agentId: agentDefinitionId,
      principalId: instancePrincipalId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .update(intxSchema.agentInstance)
      .set({ sessionId, updatedAt: now })
      .where(eq(intxSchema.agentInstance.id, instanceId));
  });

  try {
    await sessionService.launchSession({
      agentAddress: address,
      agentId: agentDefinitionId,
      instanceId,
      config: {
        sessionId,
        agentId: agentDefinitionId,
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
    });
  } catch (err) {
    // Mark session ended and instance failed so the orchestrator doesn't retry.
    await db
      .update(intxSchema.agentSession)
      .set({ status: 'ended', updatedAt: new Date() })
      .where(eq(intxSchema.agentSession.id, sessionId));
    await db
      .update(intxSchema.agentInstance)
      .set({ status: 'error', updatedAt: new Date() })
      .where(eq(intxSchema.agentInstance.id, instanceId));
    throw err;
  }

  eventCollectors.create(address, tenantId, sessionId, instanceId);

  await db
    .update(intxSchema.agentInstance)
    .set({ status: 'running', updatedAt: new Date() })
    .where(eq(intxSchema.agentInstance.id, instanceId));

  return { instanceId, address, sessionId };
}

export function createDispatchTools(context: DispatchContext): AgentTool[] {
  return [
    {
      kind: 'string',
      definition: DISPATCH_AGENT_DEFINITION,
      handler: async (args, signal) => {
        if (signal.aborted) {
          throw new Error('dispatch_agent aborted before starting');
        }

        const agentDefinitionId =
          typeof args.agentDefinitionId === 'string' ? args.agentDefinitionId : '';
        const task = typeof args.task === 'string' ? args.task : '';
        if (!agentDefinitionId) throw new Error('agentDefinitionId is required');
        if (!task) throw new Error('task is required');

        const { db, tenantId, sessionService } = context;

        const agentRow = await db.query.agent.findFirst({
          where: and(
            eq(intxSchema.agent.id, agentDefinitionId),
            eq(intxSchema.agent.tenantId, tenantId)
          ),
        });
        if (!agentRow) {
          throw new Error(`Agent definition not found: ${agentDefinitionId}`);
        }
        if (agentRow.status !== 'deployed') {
          throw new Error(`Agent definition is not deployable (status: ${agentRow.status})`);
        }
        if (!agentRow.systemPrompt) {
          throw new Error('Agent definition has no system prompt');
        }

        if (signal.aborted) {
          throw new Error('dispatch_agent aborted before launch');
        }

        const launched = await launchAgentInstance(context, agentRow);

        if (signal.aborted) {
          throw new Error('dispatch_agent aborted before send');
        }

        // Resolve caller address for proper reply threading.
        const callerInstance = await db.query.agentInstance.findFirst({
          where: and(
            eq(intxSchema.agentInstance.principalId, context.principalId),
            eq(intxSchema.agentInstance.tenantId, tenantId)
          ),
        });
        const fromAddress = callerInstance?.address ?? 'dispatcher@system';

        const kp = await generateKeyPair();
        const cryptoProvider = createNodeCrypto(kp);
        const mailId = generateId('sessionMail');

        await sessionService.sendUserMessage({
          agentAddress: launched.address,
          from: fromAddress,
          messageId: `<${mailId}@system>`,
          date: new Date(),
          content: task,
          sessionId: launched.sessionId,
          tenantId,
          cryptoProvider,
        });

        log.info('Agent dispatched', {
          agentDefinitionId,
          instanceId: launched.instanceId,
          address: launched.address,
          taskLength: task.length,
        });

        return JSON.stringify(
          {
            instanceId: launched.instanceId,
            address: launched.address,
            sessionId: launched.sessionId,
            status: 'running',
          },
          null,
          2
        );
      },
    },
  ];
}

/**
 * The context the hub tool registry passes to every context tool. The
 * orchestration fields are optional there (most tools don't need them), so the
 * dispatch entry accepts this loose shape and asserts the fields it requires at
 * runtime — keeping `DISPATCH_HUB_TOOLS` assignable to the registry's
 * `ContextToolEntry` without weakening `createDispatchTools` itself.
 */
type DispatchHostContext = Pick<
  DispatchContext,
  'db' | 'tenantId' | 'principalId' | 'agentId' | 'sessionId'
> & {
  sessionService?: SessionService;
  eventCollectors?: EventCollectorRegistry;
  sidecarRouter?: SidecarRouter;
  buildToolDefinitions?: (names: string[]) => ToolDefinition[];
};

export const DISPATCH_HUB_TOOLS = {
  dispatch_agent: {
    definition: DISPATCH_AGENT_DEFINITION,
    createTools: (context: DispatchHostContext): AgentTool[] => {
      if (
        !context.sessionService ||
        !context.eventCollectors ||
        !context.sidecarRouter ||
        !context.buildToolDefinitions
      ) {
        throw new Error('dispatch_agent requires full session context (orchestration unavailable)');
      }
      return createDispatchTools(context as DispatchContext);
    },
  },
};
