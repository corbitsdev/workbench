import { describe, it, expect, mock } from 'bun:test';
import { createFatalErrorRecovery } from './fatal-error-recovery';

const AGENT_ADDRESS = 'myra@tenant.localhost';
const SESSION_ID = 'sess_abc123';

function makeTurn(
  overrides: Partial<{ hadError: boolean; errors: { category: string; message: string }[] }>
) {
  return {
    hadError: false,
    errors: [],
    ...overrides,
  };
}

function makeDb(sessionStatus: string = 'active') {
  const updateSet = mock(() => ({ where: mock(() => Promise.resolve()) }));
  const updateMock = mock(() => ({ set: updateSet }));
  return {
    query: {
      agentInstance: {
        findFirst: mock(() => Promise.resolve({ address: AGENT_ADDRESS, sessionId: SESSION_ID })),
      },
      agentSession: {
        findFirst: mock(() => Promise.resolve({ id: SESSION_ID, status: sessionStatus })),
      },
    },
    update: updateMock,
    _updateSet: updateSet,
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

  it('marks the session ended when a fatal error occurs', async () => {
    const db = makeDb('active');
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

  it('does nothing when session is already ended', async () => {
    const db = makeDb('ended');
    const onFatalError = createFatalErrorRecovery(db as never);

    onFatalError(
      AGENT_ADDRESS,
      makeTurn({ hadError: true, errors: [{ category: 'fatal', message: 'bad' }] })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(db.update).not.toHaveBeenCalled();
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

  it('handles non-fatal errors mixed with other categories correctly', async () => {
    const db = makeDb('active');
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
});
