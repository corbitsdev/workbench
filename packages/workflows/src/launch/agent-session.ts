// Upserts a run's `agent_session` so mail and spans persist from its first
// turn. See docs/agent-session-provisioning.md.
import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import {
  agentSession,
  isLiveWorkflowRunStatus,
  workflowRun,
  workflowRunLaunchSpec,
} from "@intx/db/schema";
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
  return ensureSessionForRun(db, eventCollectors, runRow);
}

async function ensureSessionForRun(
  db: DB["db"],
  eventCollectors: Pick<EventCollectorPort, "create" | "has">,
  runRow: typeof workflowRun.$inferSelect,
): Promise<string> {
  const runId = runRow.id;

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

    if (runRow.address !== null && !eventCollectors.has(runRow.address)) {
      eventCollectors.create(runRow.address, runRow.tenantId, sessionId, runRow.id);
    }
  }
  return sessionId;
}

const MAX_TRACKED_ADDRESSES = 1000;

function track(set: Set<string>, address: string): void {
  if (set.size >= MAX_TRACKED_ADDRESSES) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(address);
}

/** Creates a run's event collector on its first inference event instead of
 * its first outbound mail, so the first reply's parts are not dropped. Events
 * for an address queue behind its in-flight ensure to keep their order. Once
 * an address's collector ended (terminal event or abandon), `create` ignores
 * it, so no path (lazy dispatch or mail) can resurrect one. */
export function withLazyRunCollector<
  R extends Pick<EventCollectorRegistry, "create" | "has" | "dispatch" | "abandon">,
>(registry: R, db: DB["db"]): R {
  const pending = new Map<string, Promise<void>>();
  const closed = new Set<string>();

  const create: R["create"] = (address, ...rest) => {
    if (!closed.has(address)) registry.create(address, ...rest);
  };

  async function ensureForAddress(address: string): Promise<void> {
    if (closed.has(address)) return;
    try {
      const runRow = await db.query.workflowRun.findFirst({
        where: eq(workflowRun.address, address),
      });
      if (runRow === undefined || !isLiveWorkflowRunStatus(runRow.status)) return;
      await ensureSessionForRun(db, { has: registry.has, create }, runRow);
    } catch (err) {
      reportError(err, { operation: "workflows.lazyRunCollector.ensure", extra: { address } });
    }
  }

  const dispatch: R["dispatch"] = (address, event) => {
    const terminal =
      event.type === "reactor.done" || (event.type === "reactor.error" && event.data.fatal);
    const deliver = () => {
      registry.dispatch(address, event);
      if (terminal) track(closed, address);
    };
    const inFlight = pending.get(address);
    if (inFlight === undefined && (registry.has(address) || closed.has(address))) {
      deliver();
      return;
    }
    const next = (inFlight ?? ensureForAddress(address)).then(deliver).catch((err: unknown) => {
      reportError(err, { operation: "workflows.lazyRunCollector.dispatch", extra: { address } });
    });
    pending.set(address, next);
    void next.finally(() => {
      if (pending.get(address) === next) pending.delete(address);
    });
  };

  const abandon: R["abandon"] = (address) => {
    track(closed, address);
    registry.abandon(address);
  };

  return { ...registry, create, dispatch, abandon };
}
