import { and, eq, ne } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import type { TurnFinalized } from "@workbench/event-collector";

const log = getLogger(["api", "fatal-error-recovery"]);

const { agentInstance, agentSession, inferenceTurn } = intxSchema;

/**
 * Returns a callback suitable for use as `onTurnFinalized` in the event
 * collector registry. When a turn ends with a fatal inference error the
 * corrupt turn is deleted from the DB and the session is marked ended so the
 * next relaunchInstanceIfNeeded restarts the agent without replaying the bad
 * turn forever.
 *
 * Scope: `inferenceTurn` here is the UI/turns *projection*, not the inference
 * context. The reactor sends DeepSeek the isogit `ContextStore`
 * (`contextStore.load()`), never this table, and `turn_part` cascades on
 * delete — so this delete cannot cause or fix a provider 400, and cannot
 * leave the projection inconsistent. Its job is to drop the corrupt row from
 * the UI and to end the session so relaunch happens. The inference-correctness
 * repair lives in `@workbench/context-repair` (`healTurns`), applied to the
 * isogit store at launch. Do not "harden" this delete to be tool_call-aware:
 * it operates on a store inference never reads.
 */
export function createFatalErrorRecovery(db: DB["db"]) {
  return function onFatalError(
    agentAddress: string,
    turn: TurnFinalized,
  ): void {
    const hasFatalError =
      turn.hadError && turn.errors.some((e) => e.category === "fatal");
    if (!hasFatalError) return;

    recoverFromFatalError(db, agentAddress, turn.turnId).catch((err) => {
      log.error("Failed to recover from fatal inference error", {
        agentAddress,
        error: err,
      });
    });
  };
}

async function recoverFromFatalError(
  db: DB["db"],
  agentAddress: string,
  turnId: string,
): Promise<void> {
  await deleteCorruptTurn(db, turnId);
  await endSessionForAddress(db, agentAddress);
}

async function deleteCorruptTurn(db: DB["db"], turnId: string): Promise<void> {
  await db.delete(inferenceTurn).where(eq(inferenceTurn.id, turnId));

  log.info("Deleted corrupt inference turn that caused fatal error", {
    turnId,
  });
}

async function endSessionForAddress(
  db: DB["db"],
  agentAddress: string,
): Promise<void> {
  const instance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.address, agentAddress),
  });
  if (!instance?.sessionId) return;

  const now = new Date();
  const updated = await db
    .update(agentSession)
    .set({ status: "ended", endedAt: now, updatedAt: now })
    .where(
      and(
        eq(agentSession.id, instance.sessionId),
        ne(agentSession.status, "ended"),
      ),
    )
    .returning({ id: agentSession.id });

  if (updated.length === 0) return;

  log.info(
    "Ended session after fatal inference error — agent will relaunch on next request",
    {
      agentAddress,
      sessionId: instance.sessionId,
    },
  );
}
