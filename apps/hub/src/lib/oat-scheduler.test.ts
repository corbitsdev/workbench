import { describe, expect, it, mock } from 'bun:test';
import { triggerOatInstances, type OatSchedulerDB } from './oat-scheduler';
import type { SessionService } from '@intx/hub-sessions';

// Minimal mock DB that satisfies OatSchedulerDB.
function makeMockDB(
  instances: Array<{ id: string; address: string; tenantId: string; sessionId: string | null }>
): OatSchedulerDB {
  return {
    select: mock(() => ({
      from: mock(() => ({
        innerJoin: mock(() => ({
          where: mock(() => Promise.resolve(instances)),
        })),
      })),
    })),
  };
}

function makeMockSessionService(): SessionService {
  return {
    launchSession: mock(() => Promise.resolve()),
    sendUserMessage: mock(() => Promise.resolve(new Uint8Array())),
    endSession: mock(() => Promise.resolve()),
  };
}

describe('triggerOatInstances', () => {
  it('sends a trigger message to each running Oat instance with an active session', async () => {
    const instances = [
      { id: 'inst-1', address: 'inst-1@ws1.localhost', tenantId: 'tenant-1', sessionId: 'sess-1' },
      { id: 'inst-2', address: 'inst-2@ws2.localhost', tenantId: 'tenant-2', sessionId: 'sess-2' },
    ];

    const db = makeMockDB(instances);
    const sessionService = makeMockSessionService();

    await triggerOatInstances(db, sessionService);

    expect(sessionService.sendUserMessage).toHaveBeenCalledTimes(2);

    const firstCall = (sessionService.sendUserMessage as ReturnType<typeof mock>).mock
      .calls[0]?.[0];
    expect(firstCall.agentAddress).toBe('inst-1@ws1.localhost');
    expect(firstCall.from).toBe('scheduler@system');
    expect(firstCall.tenantId).toBe('tenant-1');
    expect(firstCall.sessionId).toBe('sess-1');
    expect(typeof firstCall.content).toBe('string');
    expect(firstCall.content.length).toBeGreaterThan(0);
  });

  it('skips instances with no active session', async () => {
    const instances = [
      { id: 'inst-1', address: 'inst-1@ws1.localhost', tenantId: 'tenant-1', sessionId: null },
    ];

    const db = makeMockDB(instances);
    const sessionService = makeMockSessionService();

    await triggerOatInstances(db, sessionService);

    expect(sessionService.sendUserMessage).not.toHaveBeenCalled();
  });

  it('continues to other instances when one trigger fails', async () => {
    const instances = [
      { id: 'inst-1', address: 'inst-1@ws1.localhost', tenantId: 'tenant-1', sessionId: 'sess-1' },
      { id: 'inst-2', address: 'inst-2@ws2.localhost', tenantId: 'tenant-2', sessionId: 'sess-2' },
    ];

    const db = makeMockDB(instances);
    const sessionService = makeMockSessionService();

    let callCount = 0;
    (sessionService.sendUserMessage as ReturnType<typeof mock>).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('sidecar unavailable'));
      return Promise.resolve(new Uint8Array());
    });

    // Should not throw even when one instance fails.
    await triggerOatInstances(db, sessionService);

    expect(callCount).toBe(2);
  });
});
