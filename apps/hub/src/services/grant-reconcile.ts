import { and, eq } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import type { SidecarRouter } from '@intx/hub-sessions';
import type { GrantStore } from '@intx/types/authz';
import type { AgentTemplate } from '@workbench/agents';
import { memberAgentInstance } from '../db/schema';
import type { HubDb } from '../db';
import { getConfig } from '../config';
import { getToolNamesFromCapabilities } from '../lib/tool-registry';
import { TOOL_GRANT_RESOURCE_PREFIX } from '../lib/tool-grants';
import {
  persistInstanceToolGrants,
  persistInstanceGrantRequirements,
  type GrantRequirementRow,
} from './agent-provisioning';

const { agent, agentInstance, grant, tenant } = intxSchema;
const log = getLogger('grant-reconcile');

export interface TemplateReconcileResult {
  templateKey: string;
  /** Member instances whose grant rows were rewritten to the current definition. */
  reconciled: number;
  /** Of those, how many were live on a sidecar and received an immediate grants push. */
  pushed: number;
  /** Member instances skipped because their agent_instance row is gone. */
  skipped: number;
}

/**
 * When supplied, live (routable) member instances get an immediate sidecar
 * grants push so a running session sees the reconciled grants without a
 * restart. Omit at boot: sidecars reconnect *after* the hub comes up and the
 * orchestrator pushes the current DB grants on reconnect, so the DB write is
 * sufficient there.
 */
export interface LiveReconcileDeps {
  sidecarRouter: SidecarRouter;
  grantStore: GrantStore;
}

export interface InstanceGrantRefreshTarget {
  agentId: string;
  tenantId: string;
  principalId: string;
  address: string;
}

/**
 * Rewrite one instance principal's tool + requirement grants from its org agent
 * definition. When `live` is supplied and the address is routable, push the new
 * snapshot to the sidecar without restarting the agent (same as POST …/sessions
 * for an already-live instance).
 */
export async function refreshInstanceGrantsFromDefinition(
  db: DB['db'],
  instance: InstanceGrantRefreshTarget,
  live?: LiveReconcileDeps
): Promise<{ refreshed: boolean; pushed: boolean }> {
  const agentRow = await db.query.agent.findFirst({
    where: eq(agent.id, instance.agentId),
  });
  if (!agentRow) {
    return { refreshed: false, pushed: false };
  }

  const toolNames = getToolNamesFromCapabilities(agentRow.capabilities ?? null);
  const now = new Date();
  await persistInstanceToolGrants(db, {
    tenantId: instance.tenantId,
    principalId: instance.principalId,
    toolNames,
    now,
  });
  await persistInstanceGrantRequirements(db, {
    tenantId: instance.tenantId,
    principalId: instance.principalId,
    grantRequirements: (agentRow.grantRequirements ?? []) as GrantRequirementRow[],
    now,
  });

  if (!live || !live.sidecarRouter.getRoutableAddresses().includes(instance.address)) {
    return { refreshed: true, pushed: false };
  }

  const grants = await live.grantStore.collectGrants(instance.principalId, instance.tenantId);
  await live.sidecarRouter.sendGrantsUpdate(instance.address, grants);
  await db
    .update(agentInstance)
    .set({ updatedAt: new Date() })
    .where(eq(agentInstance.address, instance.address));
  return { refreshed: true, pushed: true };
}

/**
 * Reconcile every member instance's persisted tool + requirement grants to its
 * agent definition's CURRENT capabilities.
 *
 * Tool grants are otherwise only synthesized at session launch
 * (`persistInstanceToolGrants`), and `provisionMemberInstances` skips members
 * who already have an instance — so a tool added to a template (e.g. Granola on
 * Myra) never reaches existing members until each is relaunched, surfacing as
 * `No matching grants for tool:…/invoke` at invoke time. This closes that gap:
 * it rewrites grants from the same source the working launch path uses (the org
 * definition's stored, canonicalized capabilities), is idempotent (delete +
 * reinsert, scoped to one instance principal), and never restarts an agent.
 *
 * Privilege boundary: grants are derived solely from the org definition, so a
 * member can only ever gain exactly what the template authorizes — no
 * escalation. Per-member `instance:` data-access grants are untouched.
 */
export async function reconcileMemberInstanceGrants(
  db: DB['db'],
  templates: AgentTemplate[],
  live?: LiveReconcileDeps
): Promise<TemplateReconcileResult[]> {
  const { slug } = getConfig().globalTenant;
  const globalTenant = await db.query.tenant.findFirst({
    where: eq(tenant.slug, slug),
  });
  if (!globalTenant) {
    log.warn('Global tenant not seeded — skipping grant reconciliation', { slug });
    return [];
  }
  const tenantId = globalTenant.id;
  const hubDb = db as unknown as HubDb;
  const results: TemplateReconcileResult[] = [];

  for (const template of templates) {
    const def = await db.query.agent.findFirst({
      where: and(eq(agent.tenantId, tenantId), eq(agent.name, template.name)),
    });
    if (!def) continue;

    const mappings = await hubDb.query.memberAgentInstance.findMany({
      where: and(
        eq(memberAgentInstance.tenantId, tenantId),
        eq(memberAgentInstance.templateKey, template.key)
      ),
    });
    if (mappings.length === 0) continue;

    const toolNames = getToolNamesFromCapabilities(def.capabilities ?? null);

    let reconciled = 0;
    let pushed = 0;
    let skipped = 0;

    for (const mapping of mappings) {
      const instance = await db.query.agentInstance.findFirst({
        where: eq(agentInstance.id, mapping.instanceId),
      });
      if (!instance) {
        skipped += 1;
        continue;
      }

      const { pushed: didPush } = await refreshInstanceGrantsFromDefinition(
        db,
        {
          agentId: def.id,
          tenantId,
          principalId: instance.principalId,
          address: instance.address,
        },
        live
      );
      reconciled += 1;
      if (didPush) {
        pushed += 1;
      }
    }

    log.info('Reconciled member instance grants', {
      templateKey: template.key,
      reconciled,
      pushed,
      skipped,
      toolCount: toolNames.length,
    });
    results.push({ templateKey: template.key, reconciled, pushed, skipped });
  }

  return results;
}

function sortedToolNames(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}

function grantToolNamesEqual(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) return false;
  }
  return true;
}

async function toolGrantNamesForPrincipal(
  db: DB['db'],
  tenantId: string,
  principalId: string
): Promise<string[]> {
  const rows = await db
    .select({ resource: grant.resource })
    .from(grant)
    .where(
      and(
        eq(grant.tenantId, tenantId),
        eq(grant.principalId, principalId),
        eq(grant.action, 'invoke'),
        eq(grant.effect, 'allow')
      )
    );
  const names: string[] = [];
  for (const row of rows) {
    if (row.resource.startsWith(TOOL_GRANT_RESOURCE_PREFIX)) {
      names.push(row.resource.slice(TOOL_GRANT_RESOURCE_PREFIX.length));
    }
  }
  return sortedToolNames(names);
}

/** Read-only: whether POST /v1/me should run again (GET must not mutate). */
export async function personalAgentUpdateAvailable(
  db: DB['db'],
  paInstanceId: string | null
): Promise<boolean> {
  if (!paInstanceId) {
    return true;
  }

  const instance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, paInstanceId),
  });
  if (!instance || instance.endedAt) {
    return true;
  }

  const agentRow = await db.query.agent.findFirst({
    where: eq(agent.id, instance.agentId),
  });
  if (!agentRow) {
    return true;
  }

  const expected = sortedToolNames(getToolNamesFromCapabilities(agentRow.capabilities ?? null));
  const actual = await toolGrantNamesForPrincipal(db, instance.tenantId, instance.principalId);
  if (!grantToolNamesEqual(expected, actual)) {
    return true;
  }

  if (agentRow.updatedAt.getTime() > instance.updatedAt.getTime()) {
    return true;
  }

  return false;
}
