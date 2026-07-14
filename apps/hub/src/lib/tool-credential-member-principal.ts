import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { HubDb } from "../db";
import { schema as hubSchema } from "../db";

const { agentInstance, principal } = intxSchema;
const { workflowRunRecord } = hubSchema;

/** Step agent row ids follow `ins_<deploymentId>-<stepId>` (see workflow deploy). */
export function stepAgentIdMatchesDeployment(
  stepAgentId: string,
  deploymentId: string,
): boolean {
  return stepAgentId.startsWith(`ins_${deploymentId}-`);
}

/**
 * Resolve the human member principal whose OAuth / member-scoped tool credentials
 * should be used for this tool-credentials request.
 *
 * Precedence:
 * 1. `workflowRunId` → run record `principalId` (run creator), with deployment/agent alignment.
 * 2. Explicit `memberPrincipalId` when it is a user principal in the tenant.
 * 3. `agent_instance` row matching `agentId` (live session owner or step instance owner).
 */
export async function resolveToolCredentialMemberPrincipal(
  db: HubDb,
  args: {
    tenantId: string;
    agentId: string;
    workflowRunId?: string;
    memberPrincipalId?: string;
  },
): Promise<string | null> {
  if (args.workflowRunId !== undefined && args.workflowRunId.length > 0) {
    const run = await db.query.workflowRunRecord.findFirst({
      where: and(
        eq(workflowRunRecord.id, args.workflowRunId),
        eq(workflowRunRecord.tenantId, args.tenantId),
      ),
      columns: { principalId: true, deploymentId: true },
    });
    if (!run) return null;
    if (
      run.deploymentId !== null &&
      run.deploymentId.length > 0 &&
      !stepAgentIdMatchesDeployment(args.agentId, run.deploymentId)
    ) {
      return null;
    }
    return run.principalId;
  }

  if (
    args.memberPrincipalId !== undefined &&
    args.memberPrincipalId.length > 0
  ) {
    const member = await db.query.principal.findFirst({
      where: and(
        eq(principal.id, args.memberPrincipalId),
        eq(principal.tenantId, args.tenantId),
        eq(principal.kind, "user"),
      ),
      columns: { id: true },
    });
    if (member) return args.memberPrincipalId;
    return null;
  }

  const instanceById = await db.query.agentInstance.findFirst({
    where: and(
      eq(agentInstance.id, args.agentId),
      eq(agentInstance.tenantId, args.tenantId),
    ),
    columns: { principalId: true },
  });
  if (instanceById?.principalId) return instanceById.principalId;

  const instanceByAgent = await db.query.agentInstance.findFirst({
    where: and(
      eq(agentInstance.agentId, args.agentId),
      eq(agentInstance.tenantId, args.tenantId),
    ),
    columns: { principalId: true },
  });
  return instanceByAgent?.principalId ?? null;
}