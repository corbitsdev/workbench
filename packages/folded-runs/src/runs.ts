// Lookups shared by every folded-run surface: resolving a run by id or
// address, and bridging a run's principal to its live session via the
// shared-principal bridge rather than any name derived from the run
// id.
import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { workflowRun } from "@intx/db/schema";
import { resolveRunSessionId } from "@intx/hub-sessions";

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
