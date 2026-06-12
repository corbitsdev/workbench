import { and, eq, ne } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import { getLogger } from '@intx/log';
import type { TurnFinalized } from '@workbench/event-collector';

const log = getLogger(['api', 'fatal-error-recovery']);

const { agentInstance, agentSession } = intxSchema;

/**
 * Returns a callback suitable for use as `onTurnFinalized` in the event
 * collector registry. When a turn ends with a fatal inference error the
 * session is marked ended so the next relaunchInstanceIfNeeded restarts the
 * agent with a clean history instead of replaying the bad turn forever.
 */
export function createFatalErrorRecovery(db: DB['db']) {
  return function onFatalError(agentAddress: string, turn: TurnFinalized): void {
    const hasFatalError = turn.hadError && turn.errors.some((e) => e.category === 'fatal');
    if (!hasFatalError) return;

    endSessionForAddress(db, agentAddress).catch((err) => {
      log.error('Failed to end session after fatal inference error', {
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

  const now = new Date();
  const updated = await db
    .update(agentSession)
    .set({ status: 'ended', endedAt: now, updatedAt: now })
    .where(and(eq(agentSession.id, instance.sessionId), ne(agentSession.status, 'ended')))
    .returning({ id: agentSession.id });

  if (updated.length === 0) return;

  log.info('Ended session after fatal inference error — agent will relaunch on next request', {
    agentAddress,
    sessionId: instance.sessionId,
  });
}
