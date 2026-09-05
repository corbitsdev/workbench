// Resolves a provisioned run's session id via Interchange's
// shared-principal bridge rather than any name derived from the run id.
import type { DB } from "@intx/db";
import { resolveRunSessionId } from "@intx/hub-sessions";

export async function resolveRunSessionIdOrThrow(
  db: DB["db"],
  run: { principalId: string | null },
): Promise<string> {
  const sessionId = await resolveRunSessionId(db, run.principalId, {
    includeEnded: true,
  });
  if (sessionId === null) {
    throw new Error(
      "no agent_session found for this run's principal; provision may not have completed",
    );
  }
  return sessionId;
}
