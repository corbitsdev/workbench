import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { schema as intxSchema, createGrantStore } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import type { AgentTool } from "@intx/agent";
import type {
  SessionService,
  EventCollectorRegistry,
  SidecarRouter,
} from "@workbench/hub-sessions";
import type { CryptoProvider } from "@intx/types/runtime";
import { INVOKE_AGENT_DEFINITION } from "@workbench/tools-agents";
import {
  INVOKE_TEMPLATE_KEY,
  withInvokeSessionMarker,
  isPersonalAgentDefinitionName,
} from "@workbench/myra";
import type { HubDb } from "../db";
import { memberAgentInstance } from "../db/schema";
import { launchAgentSession } from "../services/agent-provisioning";
import { getToolNamesFromCapabilities } from "../lib/tool-registry";
import { resolveOwningMemberPrincipalId } from "./list-agents";
import type { ContextToolEntry } from "../lib/tool-registry";
import {
  recordInvokedSubagentForConversation,
  resolveMemberOwnedConversation,
} from "../services/invoked-subagents";

export { INVOKE_AGENT_DEFINITION };

const log = getLogger(["tools", "invoke-agent"]);

const { agent, agentInstance, principal, tenant } = intxSchema;

const InvokeAgentArgs = type({
  agentDefinitionId: "string > 0",
  brief: "string > 0",
});

type InvokeResult = {
  instanceId: string;
  address: string;
  status: "invoked";
  reused: boolean;
};

export type InvokeAgentContext = {
  db: HubDb;
  tenantId: string;
  principalId: string;
  sessionService: SessionService;
  eventCollectors: EventCollectorRegistry;
  sidecarRouter: SidecarRouter;
  cryptoProvider: CryptoProvider;
};

type ProvisionedInstance = {
  instanceId: string;
  instancePrincipalId: string;
  address: string;
  reused: boolean;
};

/**
 * In-process per-instance serialization of the routable-check + launch step.
 * Two concurrent invoke_agent calls that resolved the same instance must not
 * both call launchAgentSession for it — the second deploy evicts the first on
 * the sidecar (mail 502). launchSession resolves only after the sidecar
 * acknowledges the deploy, so the serialized loser observes the winner's
 * address as routable and reuses its session instead of relaunching.
 *
 * An in-process mutex is sufficient because the hub runs single-replica (see
 * Railway deploy config: overlap is bounded and the hub is pinned to one
 * instance); a multi-replica hub would need an advisory lock here instead.
 */
const launchLocks = new Map<string, Promise<void>>();

async function withInstanceLaunchLock<T>(
  instanceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = launchLocks.get(instanceId) ?? Promise.resolve();
  const current = previous.then(fn);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  launchLocks.set(instanceId, settled);
  try {
    return await current;
  } finally {
    if (launchLocks.get(instanceId) === settled) {
      launchLocks.delete(instanceId);
    }
  }
}

/**
 * True for a PostgreSQL unique-violation (SQLSTATE 23505) surfaced through
 * the driver: the losing side of a concurrent provisioning race against the
 * partial unique index on invoked-subagent attribution rows.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    message.includes("duplicate key value violates unique constraint")
  );
}

async function findExistingInvokedInstance(
  context: InvokeAgentContext,
  ownerPrincipalId: string,
  agentDefinitionId: string,
): Promise<ProvisionedInstance | null> {
  const { db, tenantId } = context;
  const existingMapping = await db.query.memberAgentInstance.findFirst({
    where: and(
      eq(memberAgentInstance.tenantId, tenantId),
      eq(memberAgentInstance.memberPrincipalId, ownerPrincipalId),
      eq(memberAgentInstance.agentId, agentDefinitionId),
      eq(memberAgentInstance.templateKey, INVOKE_TEMPLATE_KEY),
    ),
  });
  if (!existingMapping) return null;
  const existingInstance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, existingMapping.instanceId),
  });
  if (!existingInstance) return null;
  return {
    instanceId: existingInstance.id,
    instancePrincipalId: existingInstance.principalId,
    address: existingInstance.address,
    reused: true,
  };
}

/**
 * Resolve an existing subagent instance this member already invoked for the
 * given definition, or provision a new one. Provisioning writes the
 * `member_agent_instance` attribution row in the SAME transaction as the
 * `principal`/`agentInstance` rows and BEFORE calling `launchAgentSession` —
 * matching mailbox-triage's and myra-threads' ordering — so
 * `launchAgentSession`'s provision-failure cleanup (which only skips its
 * blanket grant delete when a `member_agent_instance` binding already exists
 * for the instance) never wipes a fresh instance's just-persisted grants.
 *
 * Concurrency: the check-then-insert race between two parallel invoke_agent
 * calls (Myra can emit parallel tool calls) is closed by the partial unique
 * index on (tenant, member, agent) for the invoked-subagent template key
 * (migration 0061); the loser's transaction fails with a unique violation
 * and adopts the winner's row instead of provisioning a duplicate.
 */
async function resolveOrProvisionInstance(
  context: InvokeAgentContext,
  ownerPrincipalId: string,
  agentDefinitionId: string,
  tenantDomain: string,
): Promise<ProvisionedInstance> {
  const { db, tenantId } = context;

  const existing = await findExistingInvokedInstance(
    context,
    ownerPrincipalId,
    agentDefinitionId,
  );
  if (existing) return existing;

  const now = new Date();
  const instanceId = generateId("instance");
  const mappingId = generateId("instance");
  const instancePrincipalId = generateId("principal");
  const address = `${instanceId}@${tenantDomain}`;

  try {
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as HubDb;
      await insertProvisioningRows(tx, {
        tenantId,
        ownerPrincipalId,
        agentDefinitionId,
        instanceId,
        mappingId,
        instancePrincipalId,
        address,
        now,
      });
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await findExistingInvokedInstance(
      context,
      ownerPrincipalId,
      agentDefinitionId,
    );
    if (!winner) throw err;
    return winner;
  }

  return { instanceId, instancePrincipalId, address, reused: false };
}

async function insertProvisioningRows(
  tx: HubDb,
  row: {
    tenantId: string;
    ownerPrincipalId: string;
    agentDefinitionId: string;
    instanceId: string;
    mappingId: string;
    instancePrincipalId: string;
    address: string;
    now: Date;
  },
): Promise<void> {
  const {
    tenantId,
    ownerPrincipalId,
    agentDefinitionId,
    instanceId,
    mappingId,
    instancePrincipalId,
    address,
    now,
  } = row;
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
    agentId: agentDefinitionId,
    tenantId,
    principalId: instancePrincipalId,
    address,
    status: "deployed",
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(memberAgentInstance).values({
    id: mappingId,
    tenantId,
    memberPrincipalId: ownerPrincipalId,
    templateKey: INVOKE_TEMPLATE_KEY,
    agentId: agentDefinitionId,
    instanceId,
    label: `Invoked: ${agentDefinitionId}`,
    createdAt: now,
    lastActivityAt: now,
  });
}

export function createInvokeAgentTool(
  context: InvokeAgentContext,
): AgentTool[] {
  return [
    {
      kind: "string",
      definition: INVOKE_AGENT_DEFINITION,
      handler: async (args, signal) => {
        if (signal.aborted) {
          throw new Error("invoke_agent aborted before starting");
        }

        const parsed = InvokeAgentArgs(args);
        if (parsed instanceof type.errors) {
          throw new Error(parsed.summary);
        }
        const { agentDefinitionId, brief } = parsed;
        const { db, tenantId } = context;

        const ownerPrincipalId = await resolveOwningMemberPrincipalId(db, {
          tenantId,
          principalId: context.principalId,
        });
        if (ownerPrincipalId === null) {
          throw new Error(
            "invoke_agent requires a member-owned caller; this agent is not attributed to a member",
          );
        }

        const agentRow = await db.query.agent.findFirst({
          where: and(
            eq(agent.id, agentDefinitionId),
            eq(agent.tenantId, tenantId),
          ),
        });
        if (!agentRow) {
          throw new Error(`Agent definition not found: ${agentDefinitionId}`);
        }
        if (agentRow.status !== "deployed") {
          throw new Error(
            `Agent definition is not deployable (status: ${agentRow.status})`,
          );
        }
        // Product rule: shared specialist definitions are invocable by any
        // tenant member, but personal agent definitions never are (nobody
        // invokes a second Myra).
        if (isPersonalAgentDefinitionName(agentRow.name)) {
          throw new Error(
            "invoke_agent cannot target a personal agent definition; invoke a shared specialist instead",
          );
        }
        if (!agentRow.systemPrompt) {
          throw new Error("Agent definition has no system prompt");
        }

        const tenantRow = await db.query.tenant.findFirst({
          where: eq(tenant.id, tenantId),
        });
        if (!tenantRow?.domain) {
          throw new Error("Tenant has no domain configured");
        }

        if (signal.aborted) {
          throw new Error("invoke_agent aborted before provisioning");
        }

        const { instanceId, instancePrincipalId, address, reused } =
          await resolveOrProvisionInstance(
            context,
            ownerPrincipalId,
            agentDefinitionId,
            tenantRow.domain,
          );

        // The routable-check + launch runs under a per-instance lock: two
        // concurrent invokes that both resolved the same non-routable
        // instance must not both launch it (the second launch evicts the
        // first on the sidecar — the mail-502 hazard). The loser re-checks
        // routability inside the lock and reuses the winner's session.
        const sessionId = await withInstanceLaunchLock(instanceId, async () => {
          // Only relaunch when the instance is not already live: relaunching
          // a routable instance evicts it on the sidecar ("Agent already
          // exists" → router eviction → mail 502), the same hazard
          // `relaunchInstanceIfNeeded` guards against for the personal-agent
          // sync path.
          const alreadyRoutable = context.sidecarRouter
            .getRoutableAddresses()
            .includes(address);

          if (alreadyRoutable) {
            const instanceRow = await db.query.agentInstance.findFirst({
              where: eq(agentInstance.id, instanceId),
            });
            if (!instanceRow?.sessionId) {
              throw new Error(
                `Invoked instance ${instanceId} is routable but has no active session`,
              );
            }
            return instanceRow.sessionId;
          }

          const toolNames = getToolNamesFromCapabilities(
            agentRow.capabilities ?? null,
          );
          const launched = await launchAgentSession(
            db,
            context.sessionService,
            createGrantStore(db),
            context.eventCollectors,
            {
              agentId: agentDefinitionId,
              instanceId,
              instancePrincipalId,
              tenantId,
              tenantDomain: tenantRow.domain,
              systemPrompt: withInvokeSessionMarker(agentRow.systemPrompt),
              persona: { toolNames },
              now: new Date(),
            },
          );
          return launched.sessionId;
        });

        if (signal.aborted) {
          throw new Error("invoke_agent aborted before send");
        }

        // The owner resolution above already proved the caller is a real
        // member-owned instance, so a missing row here is an invariant
        // violation, not an expected state — fail loudly rather than send
        // from a made-up address.
        const callerInstance = await db.query.agentInstance.findFirst({
          where: and(
            eq(agentInstance.principalId, context.principalId),
            eq(agentInstance.tenantId, tenantId),
          ),
        });
        if (!callerInstance) {
          throw new Error(
            "Calling agent instance not found for principal; cannot address the brief",
          );
        }
        const fromAddress = callerInstance.address;

        const mailId = generateId("sessionMail");
        await context.sessionService.sendUserMessage({
          agentAddress: address,
          from: fromAddress,
          messageId: `<${mailId}@${tenantRow.domain}>`,
          date: new Date(),
          content: brief,
          sessionId,
          tenantId,
          cryptoProvider: context.cryptoProvider,
        });

        // A fresh instance's address cannot be routable yet, so mapping reuse
        // already covers the routable case.
        log.info("Agent invoked", {
          agentDefinitionId,
          instanceId,
          address,
          reused,
          briefLength: brief.length,
        });

        const callerConversation = await resolveMemberOwnedConversation(db, {
          tenantId,
          principalId: context.principalId,
        });
        if (callerConversation) {
          const subagentMapping = await db.query.memberAgentInstance.findFirst({
            where: (m, { and: a, eq: e }) =>
              a(
                e(m.tenantId, tenantId),
                e(m.memberPrincipalId, ownerPrincipalId),
                e(m.instanceId, instanceId),
                e(m.templateKey, INVOKE_TEMPLATE_KEY),
              ),
          });
          if (subagentMapping) {
            await recordInvokedSubagentForConversation({
              db,
              tenantId,
              memberPrincipalId: ownerPrincipalId,
              originConversationId: callerConversation.conversationId,
              subagentMappingId: subagentMapping.id,
            });
          }
        }

        const result: InvokeResult = {
          instanceId,
          address,
          status: "invoked",
          reused,
        };

        return JSON.stringify(result, null, 2);
      },
    },
  ];
}

export type InvokeAgentHostContext = Pick<
  InvokeAgentContext,
  "db" | "tenantId" | "principalId"
> & {
  sessionService?: SessionService;
  eventCollectors?: EventCollectorRegistry;
  sidecarRouter?: SidecarRouter;
  cryptoProvider?: CryptoProvider;
};

export const INVOKE_AGENT_HUB_TOOLS: Record<string, ContextToolEntry> = {
  invoke_agent: {
    sideEffect: "write",
    definition: INVOKE_AGENT_DEFINITION,
    createTools: (context: InvokeAgentHostContext): AgentTool[] => {
      if (
        !context.sessionService ||
        !context.eventCollectors ||
        !context.sidecarRouter ||
        !context.cryptoProvider
      ) {
        throw new Error(
          "invoke_agent requires full session context (orchestration unavailable)",
        );
      }
      return createInvokeAgentTool(context as InvokeAgentContext);
    },
  },
};
