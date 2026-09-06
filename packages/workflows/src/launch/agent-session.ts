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
// `anchorWithPrincipal`, `vendor/intx/db/src/workflow-run-store.ts`),
// through the exact same trigger path every `sendUserMessage` drives. So
// this cannot run right after provisioning (an invite sits un-triggered
// until someone actually writes into it) — call it after a send that
// just delivered the run's first turn instead. A run with no principal
// yet is a normal, expected state, not a bug: this returns `false`
// rather than throwing, and idempotent past its first successful call.
import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { agentSession, workflowRun } from "@intx/db/schema";
import type { EventCollectorRegistry } from "@intx/hub-sessions";

export type RecordAgentSessionParams = {
  /** The id `prepareProvisionedDeployment` was called with. */
  readonly sessionId: string;
} & ({ readonly anchorRunId: string } | { readonly address: string });

/**
 * The one port every launcher threads the same wrapped
 * `EventCollectorRegistry` through (`apps/hub/src/index.ts`'s
 * `eventCollectors`) — never a second registry construction. `create`
 * is what actually makes `inference_turn`/`turn_part` rows exist for a
 * run (CL-7479: nothing else ever called it once `folded-runs` was
 * deleted); `abandon` tears the collector down when a run's session
 * ends.
 */
export type EventCollectorPort = Pick<
  EventCollectorRegistry,
  "create" | "abandon"
>;

/**
 * Inserts the `agent_session` row a run needs to be mail-routable: the
 * run's `tenantId`, `definitionId` (the `agent_id` FK — the column keeps
 * its old name but targets `workflow_definition` now), and `principalId`
 * are all read fresh off the `workflow_run` row, never guessed by the
 * caller. Returns `false` (and writes nothing) when the row has no
 * principal yet, `true` once the session is recorded (or already was —
 * a second call for the same `sessionId` is a no-op, not a conflict).
 */
export async function recordAgentSessionForRun(
  db: DB["db"],
  params: RecordAgentSessionParams,
  eventCollectors: Pick<EventCollectorPort, "create">,
): Promise<boolean> {
  const runRow = await db.query.workflowRun.findFirst({
    where:
      "anchorRunId" in params
        ? eq(workflowRun.id, params.anchorRunId)
        : eq(workflowRun.address, params.address),
  });
  if (runRow === undefined || runRow.principalId === null) {
    return false;
  }

  const now = new Date();
  await db
    .insert(agentSession)
    .values({
      id: params.sessionId,
      tenantId: runRow.tenantId,
      agentId: runRow.definitionId,
      principalId: runRow.principalId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: agentSession.id });

  const agentAddress = "address" in params ? params.address : runRow.address;
  if (agentAddress !== null) {
    // Idempotent across wakes: a collector already live for this
    // address is replaced, matching the registry's own contract
    // (`event-collector-registry.ts`'s `create`).
    eventCollectors.create(
      agentAddress,
      runRow.tenantId,
      params.sessionId,
      runRow.id,
    );
  }
  return true;
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
