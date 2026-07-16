import { schema as intxSchema } from "@intx/db";
import { type } from "arktype";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { HubDb } from "../db";
import { memberAgentInstance } from "../db/schema";
import {
  listRunRecords,
  listTenantRunRecords,
} from "../workflow-executor/run-store";

const { agent, agentInstance, agentSession } = intxSchema;

// The "Agents & workflows" roster for one principal (CL-2737): the concrete
// entities a principal owns, each carrying enough identity to render a
// clickable card that deep-links to that entity's own trace. Per-item summaries
// are only the values the record model carries cheaply — an instance's session
// count and a run's kind + coarse status. Token cost is deliberately absent
// (not attributed per-principal yet; see the Cost facet's CL-2723 gap) rather
// than fabricated here.
export const RosterInstanceSchema = type({
  instanceId: "string",
  // The instance's synthetic principal — the id its own trace is keyed by.
  principalId: "string",
  // The agent definition this instance runs.
  agentId: "string",
  name: "string",
  status: "string",
  sessionCount: "number",
  // member_agent_instance.template_key — distinguishes a Myra chat thread
  // ("myra"), a triage/automation instance ("myra-triage"), and every other
  // agent kind, so the Insights roster (CL-3770) can render one row per
  // instance with a surface-specific title and badge instead of grouping by
  // agent definition.
  templateKey: "string",
  // member_agent_instance.label: a Myra thread's title, or
  // "Triage: <subject>" for a triage/automation instance. Null until the
  // thread has been named (chat) or was seeded before labeling existed.
  label: "string | null",
  // member_agent_instance.last_activity_at, ISO — the most recent activity on
  // this instance, so the roster can sort most-recent first (CL-3770).
  lastActivityAt: "string",
  // agent_instance.address — the fallback identity shown when no title/label
  // exists.
  address: "string",
});
export type RosterInstance = typeof RosterInstanceSchema.infer;

export const RosterRunSchema = type({
  runId: "string",
  kind: "string",
  status: "string",
});
export type RosterRun = typeof RosterRunSchema.infer;

export const PrincipalRosterSchema = type({
  instances: RosterInstanceSchema.array(),
  runs: RosterRunSchema.array(),
});
export type PrincipalRoster = typeof PrincipalRosterSchema.infer;

// Lists the agent instances a principal owns and the workflow runs it started,
// tenant-scoped. Instances come through the SAME workbench-owned
// member_agent_instance -> agent_instance join `resolveTimelinePrincipalIds`
// uses (tenant-pinned on both sides so an instance id reused in another tenant
// cannot bleed across the boundary), extended to recover the instance's agent
// name/status and a cheap per-instance session count. Runs reuse the run-index
// `listRunRecords` (workflow_run_record.principalId is the owning member's
// principal, not the instance's synthetic one), so the roster is the union of
// "instances this user owns" and "runs this user started".
export async function getPrincipalRoster(args: {
  db: HubDb;
  tenantId: string;
  principalId: string;
}): Promise<PrincipalRoster> {
  const instanceRows = await args.db
    .select({
      instanceId: memberAgentInstance.instanceId,
      principalId: agentInstance.principalId,
      agentId: agentInstance.agentId,
      name: agent.name,
      status: agentInstance.status,
      templateKey: memberAgentInstance.templateKey,
      label: memberAgentInstance.label,
      lastActivityAt: memberAgentInstance.lastActivityAt,
      address: agentInstance.address,
    })
    .from(memberAgentInstance)
    .innerJoin(
      agentInstance,
      and(
        eq(agentInstance.id, memberAgentInstance.instanceId),
        eq(agentInstance.tenantId, memberAgentInstance.tenantId),
      ),
    )
    .innerJoin(agent, eq(agent.id, agentInstance.agentId))
    .where(
      and(
        eq(memberAgentInstance.tenantId, args.tenantId),
        eq(memberAgentInstance.memberPrincipalId, args.principalId),
      ),
    );

  const syntheticIds = instanceRows.map((r) => r.principalId);
  const sessionCounts = new Map<string, number>();
  if (syntheticIds.length > 0) {
    const counts = await args.db
      .select({
        principalId: agentSession.principalId,
        count: sql<number>`count(*)::int`,
      })
      .from(agentSession)
      .where(
        and(
          eq(agentSession.tenantId, args.tenantId),
          inArray(agentSession.principalId, syntheticIds),
        ),
      )
      .groupBy(agentSession.principalId);
    for (const c of counts) {
      sessionCounts.set(c.principalId, Number(c.count));
    }
  }

  const instances = instanceRows
    .map((r) => ({
      instanceId: r.instanceId,
      principalId: r.principalId,
      agentId: r.agentId,
      name: r.name,
      status: r.status,
      sessionCount: sessionCounts.get(r.principalId) ?? 0,
      templateKey: r.templateKey,
      label: r.label,
      lastActivityAt: r.lastActivityAt.toISOString(),
      address: r.address,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const runRows = await listRunRecords(
    args.db,
    [args.tenantId],
    args.principalId,
  );
  const runs = runRows.map((r) => ({
    runId: r.runId,
    kind: r.kind,
    status: r.status,
  }));

  const parsed = PrincipalRosterSchema({ instances, runs });
  if (parsed instanceof type.errors) {
    throw new Error(`Principal roster failed validation: ${parsed.summary}`);
  }
  return parsed;
}

// The tenant-wide roster reuses the same per-item shapes as the principal
// roster, but scopes to a whole tenant rather than one owner.
export const TenantRosterSchema = type({
  instances: RosterInstanceSchema.array(),
  runs: RosterRunSchema.array(),
});
export type TenantRoster = typeof TenantRosterSchema.infer;

// The default cap on the tenant-wide recent-runs list — enough to make runs a
// first-class, clickable surface on the dashboard without unbounded fan-out.
export const TENANT_ROSTER_RUN_LIMIT = 30;

// Lists EVERY agent instance owned in a tenant and the tenant's most recent
// workflow runs — the tenant-wide analogue of getPrincipalRoster. Instances
// come through the same member_agent_instance -> agent_instance join (deduped
// per instance, since a shared instance maps to more than one member), so each
// carries its synthetic principal id for deep-linking to that instance's trace.
// Runs come from the owner-agnostic listTenantRunRecords, most-recent first.
export async function getTenantRoster(args: {
  db: HubDb;
  tenantId: string;
  runLimit?: number;
}): Promise<TenantRoster> {
  const instanceRows = await args.db
    .selectDistinctOn([memberAgentInstance.instanceId], {
      instanceId: memberAgentInstance.instanceId,
      principalId: agentInstance.principalId,
      agentId: agentInstance.agentId,
      name: agent.name,
      status: agentInstance.status,
      templateKey: memberAgentInstance.templateKey,
      label: memberAgentInstance.label,
      lastActivityAt: memberAgentInstance.lastActivityAt,
      address: agentInstance.address,
    })
    .from(memberAgentInstance)
    .innerJoin(
      agentInstance,
      and(
        eq(agentInstance.id, memberAgentInstance.instanceId),
        eq(agentInstance.tenantId, memberAgentInstance.tenantId),
      ),
    )
    .innerJoin(agent, eq(agent.id, agentInstance.agentId))
    .where(eq(memberAgentInstance.tenantId, args.tenantId));

  const syntheticIds = instanceRows.map((r) => r.principalId);
  const sessionCounts = new Map<string, number>();
  if (syntheticIds.length > 0) {
    const counts = await args.db
      .select({
        principalId: agentSession.principalId,
        count: sql<number>`count(*)::int`,
      })
      .from(agentSession)
      .where(
        and(
          eq(agentSession.tenantId, args.tenantId),
          inArray(agentSession.principalId, syntheticIds),
        ),
      )
      .groupBy(agentSession.principalId);
    for (const c of counts) {
      sessionCounts.set(c.principalId, Number(c.count));
    }
  }

  const instances = instanceRows
    .map((r) => ({
      instanceId: r.instanceId,
      principalId: r.principalId,
      agentId: r.agentId,
      name: r.name,
      status: r.status,
      sessionCount: sessionCounts.get(r.principalId) ?? 0,
      templateKey: r.templateKey,
      label: r.label,
      lastActivityAt: r.lastActivityAt.toISOString(),
      address: r.address,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const runRows = await listTenantRunRecords(
    args.db,
    args.tenantId,
    args.runLimit ?? TENANT_ROSTER_RUN_LIMIT,
  );
  const runs = runRows.map((r) => ({
    runId: r.runId,
    kind: r.kind,
    status: r.status,
  }));

  const parsed = TenantRosterSchema({ instances, runs });
  if (parsed instanceof type.errors) {
    throw new Error(`Tenant roster failed validation: ${parsed.summary}`);
  }
  return parsed;
}
