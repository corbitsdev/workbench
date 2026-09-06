// Every Workbench launch path provisions through Interchange's
// `prepareProvisionedDeployment` with a `sessionId` it mints itself, but
// nothing ever wrote that id into `agent_session` (vendor-owned,
// `vendor/intx/db/src/schema/sessions.ts`) — the table
// `resolveRunSessionId` (`vendor/intx/hub-sessions/src/hub-session-lookups.ts`)
// reads to route a run's outbound mail. Before the folded-runs package
// was deleted it was the only writer of that table; every current
// launcher must now do this itself, through this one shared helper, so
// mail and spans persist against a real session from the run's first
// turn (CL-7477).
//
// Timing matters: `workflow_run.principal_id` (the FK `agent_session`
// keys on) is still null the instant `prepareProvisionedDeployment`
// returns — a provisioned anchor is born "deployed" with no principal,
// and only the run's first trigger reconciles one onto it (Interchange's
// `anchorWithPrincipal`, `vendor/intx/db/src/workflow-run-store.ts`).
// Pre-creating the run's principal to dodge this is not an option either:
// Interchange's own grant materialization
// (`vendor/intx/hub-api/src/run-grant-materialization.ts`) inserts the
// principal row `onConflictDoNothing` and treats a conflict as "grants
// already committed", throwing rather than re-materializing — so nothing
// upstream of that first trigger may write the principal first.
//
// So `ensureRunSession` (CL-7480) is lazy and idempotent rather than
// called once right after a send: every seam that might be the run's
// first mail-routable moment (a hub mailbox persist, a session
// orchestrator dispatch with no live collector yet) calls it before
// doing its own work. A run with no principal yet is a normal, expected
// state, not a bug — this returns `null` rather than throwing.
import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import {
  agentSession,
  workflowRun,
  workflowRunLaunchSpec,
} from "@intx/db/schema";
import type { EventCollectorRegistry } from "@intx/hub-sessions";

/**
 * The one port every launcher threads the same wrapped
 * `EventCollectorRegistry` through (`apps/hub/src/index.ts`'s
 * `eventCollectors`) — never a second registry construction. `create`
 * is what actually makes `inference_turn`/`turn_part` rows exist for a
 * run (CL-7479: nothing else ever called it once `folded-runs` was
 * deleted); `abandon` tears the collector down when a run's session
 * ends; `has` lets a caller check whether a collector already exists
 * before creating a second one.
 */
export type EventCollectorPort = Pick<
  EventCollectorRegistry,
  "create" | "abandon" | "has"
>;

/**
 * Idempotently makes a run's session and event collector exist, the
 * instant that becomes possible: the run's `tenantId`, `definitionId`
 * (the `agent_id` FK), and `principalId` are all read fresh off the
 * `workflow_run` row, never guessed by the caller. Returns `null` (and
 * writes nothing) when the row has no principal yet — an un-anchored
 * run is not a bug, just not ensurable yet. Returns the run's
 * `sessionId` once the session exists (freshly inserted or already
 * there — a second call for the same run is a no-op, not a conflict),
 * with the run's event collector created too if none was live for its
 * address.
 */
export async function ensureRunSession(params: {
  readonly db: DB["db"];
  readonly eventCollectors: Pick<EventCollectorPort, "create" | "has">;
  readonly runId: string;
}): Promise<string | null> {
  const { db, eventCollectors, runId } = params;
  const runRow = await db.query.workflowRun.findFirst({
    where: eq(workflowRun.id, runId),
  });
  if (runRow === undefined || runRow.principalId === null) {
    return null;
  }

  const launchSpecRow = await db.query.workflowRunLaunchSpec.findFirst({
    where: eq(workflowRunLaunchSpec.anchorRunId, runId),
  });
  if (launchSpecRow === undefined) {
    return null;
  }
  const sessionId = launchSpecRow.sessionId;

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

  if (runRow.address !== null && !eventCollectors.has(runRow.address)) {
    eventCollectors.create(
      runRow.address,
      runRow.tenantId,
      sessionId,
      runRow.id,
    );
  }
  return sessionId;
}

/**
 * Marks a run's `agent_session` ended — called only from the places that
 * already know the run died: a chat relaunch (the old run's session) or
 * a one-shot prompt's teardown. No sweeper; a run nobody reacts to stays
 * `active` until something does.
 */
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

/**
 * Same as `endAgentSessionForPrincipal`, keyed by the run's own id
 * instead — for a caller (e.g. a one-shot prompt's teardown, or a chat
 * relaunch replacing a terminal run) that only ever held the run id,
 * never minted or looked up its principal. Also abandons the outgoing
 * run's event collector, through the same shared
 * `EventCollectorPort` every launcher threads — one mechanism for
 * ending a run's session. No-ops for a run row already gone, or one
 * never triggered (no principal, hence no session was ever recorded
 * for it).
 */
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
