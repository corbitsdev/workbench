import { eq } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';

const log = getLogger(['api', 'fatal-error-recovery']);

const { agentInstance, agentSession } = intxSchema;

export type RecoverableTurn = {
  hadError: boolean;
  errors: { category: string; message: string }[];
};

/**
 * Returns a callback suitable for use as `onTurnFinalized` in the event
 * collector registry. When a turn ends with a fatal inference error the
 * session is marked ended so the next relaunchInstanceIfNeeded restarts the
 * agent with a clean history instead of replaying the bad turn forever.
 */
export function createFatalErrorRecovery(db: DB['db']) {
  return function onFatalError(agentAddress: string, turn: RecoverableTurn): void {
    const hasFatalError = turn.hadError && turn.errors.some((e) => e.category === 'fatal');
    if (!hasFatalError) return;

    endSessionForAddress(db, agentAddress).catch((err) => {
      log.warn('Failed to end session after fatal inference error', {
        agentAddress,
        error: err,
      });
    });
  };
}

async function endSessionForAddress(db: DB['db'], agentAddress: string): Promise<void> {
  const instance = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.address, agentAddress),
  });
  if (!instance?.sessionId) return;

  const session = await db.query.agentSession.findFirst({
    where: eq(agentSession.id, instance.sessionId),
  });
  if (!session || session.status === 'ended') return;

  const now = new Date();
  await db
    .update(agentSession)
    .set({ status: 'ended', endedAt: now, updatedAt: now })
    .where(eq(agentSession.id, session.id));

  log.info('Ended session after fatal inference error — agent will relaunch on next request', {
    agentAddress,
    sessionId: session.id,
  });
}
