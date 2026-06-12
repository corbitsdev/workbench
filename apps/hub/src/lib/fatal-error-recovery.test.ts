import { describe, it, expect, mock } from 'bun:test';
import { createFatalErrorRecovery } from './fatal-error-recovery';

const AGENT_ADDRESS = 'myra@tenant.localhost';
const SESSION_ID = 'sess_abc123';

function makeTurn(
  overrides: Partial<{ hadError: boolean; errors: { category: string; message: string }[] }>
) {
  return {
    turnId: 'turn-1',
    status: 'completed' as const,
    text: '',
    hadReply: false,
    hadError: false,
    errors: [],
    toolCalls: [],
    toolErrors: [],
    ...overrides,
  };
}

const TURN_ID = 'turn-1';

function makeDb(updatedRows: { id: string }[] = [{ id: SESSION_ID }]) {
  const returning = mock(() => Promise.resolve(updatedRows));
  const where = mock(() => ({ returning }));
  const set = mock(() => ({ where }));
  const updateMock = mock(() => ({ set }));
  const deleteWhere = mock(() => Promise.resolve());
  const deleteMock = mock(() => ({ where: deleteWhere }));
  return {
    query: {
      agentInstance: {
        findFirst: mock(() =>
          Promise.resolve({ address: AGENT_ADDRESS, sessionId: SESSION_ID as string | null })
        ),
      },
    },
    update: updateMock,
    delete: deleteMock,
    _where: where,
    _deleteWhere: deleteWhere,
  };
}

describe('createFatalErrorRecovery', () => {
  it('does nothing when hadError is false', async () => {
    const db = makeDb();
    const onFatalError = createFatalErrorRecovery(db as never);

    onFatalError(
      AGENT_ADDRESS,
      makeTurn({ hadError: false, errors: [{ category: 'fatal', message: 'bad' }] })
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(db.query.agentInstance.findFirst).not.toHaveBeenCalled();
  });

  it('does nothing when errors list is empty', async () => {
    const db = makeDb();
    const onFatalError = createFatalErrorRecovery(db as never);

    onFatalError(AGENT_ADDRESS, makeTurn({ hadError: true, errors: [] }));

    await new Promise((r) => setTimeout(r, 10));
    expect(db.query.agentInstance.findFirst).not.toHaveBeenCalled();
  });

  it('does nothing when error category is not fatal', async () => {
    const db = makeDb();
    const onFatalError = createFatalErrorRecovery(db as never);

    onFatalError(
      AGENT_ADDRESS,
      makeTurn({ hadError: true, errors: [{ category: 'retryable', message: 'timeout' }] })
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(db.query.agentInstance.findFirst).not.toHaveBeenCalled();
  });

  it('issues a conditional UPDATE when a fatal error occurs', async () => {
    const db = makeDb([{ id: SESSION_ID }]);
    const onFatalError = createFatalErrorRecovery(db as never);

    onFatalError(
      AGENT_ADDRESS,
      makeTurn({
        hadError: true,
        errors: [{ category: 'fatal', message: 'Invalid assistant message' }],
      })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(db.update).toHaveBeenCalled();
  });

  it('does not log when UPDATE returns zero rows (session already ended)', async () => {
    // DB returns empty array = the WHERE ne(status, 'ended') guard excluded the row.
    // The code should return early — no second update.
    const db = makeDb([]);
    const onFatalError = createFatalErrorRecovery(db as never);

    onFatalError(
      AGENT_ADDRESS,
      makeTurn({ hadError: true, errors: [{ category: 'fatal', message: 'bad' }] })
    );

    await new Promise((r) => setTimeout(r, 20));
    // UPDATE was still issued (the guard is in the WHERE clause), but only once.
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('does nothing when instance has no session', async () => {
    const db = makeDb();
    db.query.agentInstance.findFirst = mock(() =>
      Promise.resolve({ address: AGENT_ADDRESS, sessionId: null })
    );
    const onFatalError = createFatalErrorRecovery(db as never);

    onFatalError(
      AGENT_ADDRESS,
      makeTurn({ hadError: true, errors: [{ category: 'fatal', message: 'bad' }] })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(db.update).not.toHaveBeenCalled();
  });

  it('triggers on a mix of categories when any is fatal', async () => {
    const db = makeDb([{ id: SESSION_ID }]);
    const onFatalError = createFatalErrorRecovery(db as never);

    onFatalError(
      AGENT_ADDRESS,
      makeTurn({
        hadError: true,
        errors: [
          { category: 'retryable', message: 'timeout' },
          { category: 'fatal', message: 'Invalid assistant message' },
        ],
      })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(db.update).toHaveBeenCalled();
  });

  it('deletes the corrupt inference turn before ending the session', async () => {
    const db = makeDb([{ id: SESSION_ID }]);
    const onFatalError = createFatalErrorRecovery(db as never);

    onFatalError(
      AGENT_ADDRESS,
      makeTurn({
        hadError: true,
        errors: [
          {
            category: 'fatal',
            message: 'Invalid assistant message: content or tool_calls must be set',
          },
        ],
      })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(db.delete).toHaveBeenCalled();
    expect(db._deleteWhere).toHaveBeenCalled();
  });

  it('does not delete a turn when error is not fatal', async () => {
    const db = makeDb();
    const onFatalError = createFatalErrorRecovery(db as never);

    onFatalError(
      AGENT_ADDRESS,
      makeTurn({ hadError: true, errors: [{ category: 'retryable', message: 'timeout' }] })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('deletes the turn even when session update returns zero rows', async () => {
    const db = makeDb([]);
    const onFatalError = createFatalErrorRecovery(db as never);

    onFatalError(
      AGENT_ADDRESS,
      makeTurn({ hadError: true, errors: [{ category: 'fatal', message: 'bad' }] })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(db.delete).toHaveBeenCalled();
  });

  it('deletes the turn identified by turnId from TurnFinalized', async () => {
    const db = makeDb([{ id: SESSION_ID }]);
    const onFatalError = createFatalErrorRecovery(db as never);

    const turn = {
      ...makeTurn({ hadError: true, errors: [{ category: 'fatal', message: 'bad' }] }),
      turnId: TURN_ID,
    };
    onFatalError(AGENT_ADDRESS, turn);

    await new Promise((r) => setTimeout(r, 20));
    // delete was called once (the corrupt turn)
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});
