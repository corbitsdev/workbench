// Every native launcher writes the `sessionId` it mints here, so mail and
// spans persist from a run's first turn. See docs/agent-session-provisioning.md.
import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { agentSession, workflowRun, workflowRunLaunchSpec } from "@intx/db/schema";
import type { EventCollectorRegistry } from "@intx/hub-sessions";

/** The one port every launcher threads the same wrapped
 * `EventCollectorRegistry` through, never a second registry construction. */
export type EventCollectorPort = Pick<EventCollectorRegistry, "create" | "abandon" | "has">;

/** The one shared write every native launcher calls right after
 * `prepareProvisionedDeployment` returns. See
 * docs/agent-session-provisioning.md#why-timing-forces-a-two-step-write. */
export async function recordAgentSessionAtProvision(params: {
  readonly db: DB["db"];
  readonly eventCollectors: Pick<EventCollectorPort, "create" | "has">;
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceAuthorityPrincipalId: string;
}): Promise<void> {
  const { db, eventCollectors, runId, sessionId, sourceAuthorityPrincipalId } = params;
  const runRow = await db.query.workflowRun.findFirst({
    where: eq(workflowRun.id, runId),
  });
  if (runRow === undefined) {
    throw new Error(
      `recordAgentSessionAtProvision: no workflow_run "${runId}" — prepareProvisionedDeployment must have already returned`,
    );
  }

  const now = new Date();
  await db
    .insert(agentSession)
    .values({
      id: sessionId,
      tenantId: runRow.tenantId,
      agentId: runRow.definitionId,
      principalId: sourceAuthorityPrincipalId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: agentSession.id });

  if (runRow.address !== null && !eventCollectors.has(runRow.address)) {
    eventCollectors.create(runRow.address, runRow.tenantId, sessionId, runRow.id);
  }
}

/** True upsert of a run's `agent_session`, keyed by the run's own principal
 * once Interchange anchors one. See docs/agent-session-provisioning.md. */
export async function ensureRunSession(params: {
  readonly db: DB["db"];
  readonly eventCollectors: Pick<EventCollectorPort, "create" | "has">;
  readonly runId: string;
}): Promise<string | null> {
  const { db, eventCollectors, runId } = params;
  const runRow = await db.query.workflowRun.findFirst({
    where: eq(workflowRun.id, runId),
  });
  if (runRow === undefined) {
    return null;
  }

  const launchSpecRow = await db.query.workflowRunLaunchSpec.findFirst({
    where: eq(workflowRunLaunchSpec.anchorRunId, runId),
  });
  if (launchSpecRow === undefined) {
    throw new Error(
      `ensureRunSession: no workflow_run_launch_spec for run "${runId}" — every launcher records one at provision time`,
    );
  }
  const sessionId = launchSpecRow.sessionId;

  if (runRow.principalId !== null) {
    const sessionRow = await db.query.agentSession.findFirst({
      where: eq(agentSession.id, sessionId),
    });
    if (sessionRow === undefined) {
      const now = new Date();
      await db
        .insert(agentSession)
        .values({
          id: sessionId,
          tenantId: runRow.tenantId,
          agentId: runRow.definitionId,
          principalId: runRow.principalId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: agentSession.id });
    } else if (sessionRow.principalId !== runRow.principalId) {
      await db
        .update(agentSession)
        .set({ principalId: runRow.principalId, updatedAt: new Date() })
        .where(eq(agentSession.id, sessionId));
    }
  }

  if (runRow.address !== null && !eventCollectors.has(runRow.address)) {
    eventCollectors.create(runRow.address, runRow.tenantId, sessionId, runRow.id);
  }
  return sessionId;
}

/** Marks a run's `agent_session` ended. No sweeper; a run nobody reacts to
 * stays `active` until something does. */
export async function endAgentSessionForPrincipal(
  db: DB["db"],
  principalId: string,
): Promise<void> {
  const endedAt = new Date();
  await db
    .update(agentSession)
    .set({ status: "ended", endedAt, updatedAt: endedAt })
    .where(eq(agentSession.principalId, principalId));
}

/** Same as `endAgentSessionForPrincipal`, keyed by run id, plus abandons the
 * run's event collector. No-ops for a run row already gone or never
 * triggered. */
export async function endAgentSessionForRun(
  db: DB["db"],
  anchorRunId: string,
  eventCollectors: Pick<EventCollectorPort, "abandon">,
): Promise<void> {
  const runRow = await db.query.workflowRun.findFirst({
    where: eq(workflowRun.id, anchorRunId),
  });
  if (runRow === undefined || runRow.principalId === null) {
    return;
  }
  await endAgentSessionForPrincipal(db, runRow.principalId);
  if (runRow.address !== null) {
    eventCollectors.abandon(runRow.address);
  }
}
