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
// CL-7480 made `ensureRunSession` lazy: called from every seam that
// might be a run's first mail-routable moment, no-opping until a
// principal existed to key the row on. That left a real gap — a run's
// very first outbound message can itself be that seam, both for chat's
// `sendMail` (which looks the session up by run principal) and for the
// vendored `persistMail` a heartbeat run's own first outbound mail hits
// — and both landed on an un-anchored run with nothing recorded yet.
// CL-7481 fixes this at the root: `recordAgentSessionAtProvision` writes
// the row immediately after `prepareProvisionedDeployment` returns,
// keyed on the deploying principal (`sourceAuthorityPrincipalId`) since
// the run principal does not exist yet — every other field the launcher
// already knows or can read straight off the fresh run row.
// `ensureRunSession` re-keys onto the run's own principal once one is
// anchored, moving `principal_id` without ever touching the session id.
//
// That eager write only ever runs for a Workbench launcher, though — a
// run deployed straight through Interchange's own
// `POST /api/tenants/:id/workflows/deployments` route (the e2e suites,
// or any other API client) never passes through one, so no
// `agent_session` row exists for it until something creates one.
// CL-7489 makes `ensureRunSession` a true upsert: by the time
// persist/dispatch call it the run is anchored, so a missing row is
// created rather than treated as a bug.
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
 * The one shared write every native launcher calls right after its own
 * `prepareProvisionedDeployment` returns (CL-7481) — a run row exists
 * the instant that call resolves, so the session it will use is known
 * then too: the launch-spec `sessionId` it just minted, `tenantId` and
 * `definitionId` read fresh off the new `workflow_run` row (Interchange
 * resolves the asset id the caller passed to a real `workflow_definition`
 * row internally; callers never see that id themselves), and the
 * deploying principal (`sourceAuthorityPrincipalId`) standing in for the
 * run's own principal, which does not exist yet. `onConflictDoNothing`
 * makes a second call for the same run id a no-op. Every launcher threads
 * the same wrapped `EventCollectorRegistry` through here so the run's
 * `inference_turn`/`turn_part` rows have somewhere to land from its very
 * first turn.
 */
export async function recordAgentSessionAtProvision(params: {
  readonly db: DB["db"];
  readonly eventCollectors: Pick<EventCollectorPort, "create" | "has">;
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceAuthorityPrincipalId: string;
}): Promise<void> {
  const { db, eventCollectors, runId, sessionId, sourceAuthorityPrincipalId } =
    params;
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
    eventCollectors.create(
      runRow.address,
      runRow.tenantId,
      sessionId,
      runRow.id,
    );
  }
}

/**
 * True upsert of a run's `agent_session`, keyed by the run's own
 * principal once Interchange anchors one (`anchorWithPrincipal`, the
 * run's first trigger). Before that, `recordAgentSessionAtProvision`
 * records the row under the deploying principal for a Workbench-launched
 * run — but a run deployed straight through Interchange's own
 * `POST /api/tenants/:id/workflows/deployments` route (the e2e suites,
 * or any other API client) never passes through a Workbench launcher, so
 * that eager write never runs for it, and no `agent_session` row exists
 * yet when this seam is first reached. By the time persist/dispatch call
 * this, though, the run is anchored (`runRow.principalId` is set), so
 * everything needed to create the row is on hand: this inserts it rather
 * than treating the missing row as a bug. The launch-spec row is still
 * the source of truth for which session id belongs to this run — its
 * absence means a launcher provisioned this run without going through
 * the shared path, which is a bug, not a state to paper over. Also
 * creates the run's event collector if none is live for its address (a
 * fresh process has no in-memory collectors regardless of what is on
 * disk).
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
