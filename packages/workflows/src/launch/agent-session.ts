// Upserts a run's `agent_session` so mail and spans persist from its first
// turn. See docs/agent-session-provisioning.md.
import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { agentSession, workflowRun, workflowRunLaunchSpec } from "@intx/db/schema";
import type { EventCollectorRegistry } from "@intx/hub-sessions";
import { reportError } from "@corbits/error-sink";

/** The one port every launcher threads the same wrapped
 * `EventCollectorRegistry` through, never a second registry construction. */
export type EventCollectorPort = Pick<EventCollectorRegistry, "create" | "abandon" | "has">;

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

/** Creates a run's event collector on its first inference event instead of
 * its first outbound mail, so the first reply's parts are not dropped. Events
 * for an address queue behind its in-flight ensure to keep their order. */
export function withLazyRunCollector<
  R extends Pick<EventCollectorRegistry, "create" | "has" | "dispatch">,
>(registry: R, db: DB["db"]): R {
  const pending = new Map<string, Promise<void>>();

  async function ensureForAddress(address: string): Promise<void> {
    try {
      const runRow = await db.query.workflowRun.findFirst({
        where: eq(workflowRun.address, address),
      });
      if (runRow !== undefined) {
        await ensureRunSession({ db, eventCollectors: registry, runId: runRow.id });
      }
    } catch (err) {
      reportError(err, {
        operation: "workflows.lazyRunCollector.ensure",
        extra: { address },
      });
    }
  }

  const dispatch: R["dispatch"] = (address, event) => {
    const inFlight = pending.get(address);
    if (inFlight === undefined && (registry.has(address) || event.type === "reactor.done")) {
      registry.dispatch(address, event);
      return;
    }
    const next = (inFlight ?? ensureForAddress(address)).then(() => {
      registry.dispatch(address, event);
    });
    pending.set(address, next);
    void next.finally(() => {
      if (pending.get(address) === next) pending.delete(address);
    });
  };

  return { ...registry, dispatch };
}
