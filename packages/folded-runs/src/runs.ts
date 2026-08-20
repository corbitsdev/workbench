// Lookups shared by every folded-run surface: resolving a run by id or
// address, and bridging a run's principal to its live session via the
// shared-principal bridge rather than any name derived from the run
// id.
import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { workflowRun } from "@intx/db/schema";
import { resolveRunSessionId } from "@intx/hub-sessions";
import { foldedRun } from "./schema";

export function domainOf(address: string): string {
  const at = address.indexOf("@");
  if (at === -1) {
    throw new Error(`malformed agent address, missing "@": ${address}`);
  }
  return address.slice(at + 1);
}

export async function findFoldedRunById(db: DB["db"], instanceId: string) {
  return db.query.workflowRun.findFirst({
    where: eq(workflowRun.id, instanceId),
  });
}

export async function findFoldedRunByAddress(db: DB["db"], address: string) {
  return db.query.workflowRun.findFirst({
    where: eq(workflowRun.address, address),
  });
}

/**
 * A folded run's `workflow_run.status` settles to "completed" after
 * every handled mail (see `./reconnect.ts`'s header comment) — for a
 * folded run that means only "idle until its next message", never
 * done forever. A settled occurrence is still resident on the sidecar
 * (routable) until the idle-sleep sweep tears it down, so anything
 * that decides whether to wake before sending mail purely off
 * routability sends straight into a terminal occurrence, which
 * `vendor/intx/workflow-host/src/supervisor/supervisor.ts` rejects as
 * `workflow_run_terminal`. This is the folded-run-aware half of that
 * decision: "completed" alone is not enough (a one-shot deployment's
 * own genuine "done forever" also reads as "completed"), so this only
 * returns true once a `folded_run` marker row confirms the run is one
 * of this package's own occurrence-per-message runs, mirroring
 * `./reconnect.ts`'s `lookupFoldedRunReconnectKey` gate exactly.
 */
export async function isFoldedRunSettled(
  db: DB["db"],
  run: { id: string; status: string },
): Promise<boolean> {
  if (run.status !== "completed") return false;
  const marker = await db
    .select({ id: foldedRun.id })
    .from(foldedRun)
    .where(eq(foldedRun.id, run.id))
    .limit(1);
  return marker.length > 0;
}

/**
 * Resolves a folded run's session id via the shared-principal bridge
 * (`resolveRunSessionId`) rather than any name derived from the run
 * id — that bridge is what makes the run's mail listable through the
 * platform's own sanctioned per-run surfaces.
 */
export async function resolveFoldedRunSessionId(
  db: DB["db"],
  run: { principalId: string | null },
): Promise<string> {
  const sessionId = await resolveRunSessionId(db, run.principalId, {
    includeEnded: true,
  });
  if (sessionId === null) {
    throw new Error(
      "no agent_session found for this run's principal; the folded " +
        "launch may not have completed",
    );
  }
  return sessionId;
}
