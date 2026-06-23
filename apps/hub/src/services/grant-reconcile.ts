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
import {
  persistInstanceToolGrants,
  persistInstanceGrantRequirements,
  type GrantRequirementRow,
} from './agent-provisioning';

const { agent, agentInstance, tenant } = intxSchema;
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
  const routable = live ? new Set(live.sidecarRouter.getRoutableAddresses()) : null;

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
    const grantRequirements = (def.grantRequirements ?? []) as GrantRequirementRow[];

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

      const now = new Date();
      await persistInstanceToolGrants(db, {
        tenantId,
        principalId: instance.principalId,
        toolNames,
        now,
      });
      await persistInstanceGrantRequirements(db, {
        tenantId,
        principalId: instance.principalId,
        grantRequirements,
        now,
      });
      reconciled += 1;

      if (live && routable?.has(instance.address)) {
        const grants = await live.grantStore.collectGrants(instance.principalId, tenantId);
        await live.sidecarRouter.sendGrantsUpdate(instance.address, grants);
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
