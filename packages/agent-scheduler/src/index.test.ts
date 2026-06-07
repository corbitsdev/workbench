import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { startInstanceScheduler } from '@workbench/agent-scheduler';
import type { SessionService } from '@intx/hub-sessions';
import type { SidecarEventEmitter } from '@intx/hub-sessions';

type AgentEventListener = (payload: {
  agentAddress: string;
  sessionId: string;
  event: unknown;
}) => void;

function makeMockEvents(): SidecarEventEmitter & { _fire: AgentEventListener } {
  const listeners: AgentEventListener[] = [];

  const on = mock((_type: string, listener: unknown) => {
    listeners.push(listener as AgentEventListener);
    return () => {
      const idx = listeners.indexOf(listener as AgentEventListener);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  });

  const _fire: AgentEventListener = (payload) => {
    for (const l of listeners) l(payload);
  };

  return {
    on,
    emit: mock(),
    emitAndAwait: mock(async () => {}),
    listenerCount: mock(() => 0),
    _fire,
  } as unknown as SidecarEventEmitter & { _fire: AgentEventListener };
}

function makeMockSessionService(): SessionService {
  return {
    launchSession: mock(() => Promise.resolve()),
    sendUserMessage: mock(() => Promise.resolve(new Uint8Array())),
    endSession: mock(() => Promise.resolve()),
  };
}

const ADDR = 'inst-1@ws1.localhost';
const SESSION_ID = 'sess-1';
const TENANT_ID = 'tenant-1';
const TICK_MS = 50;

describe('startInstanceScheduler', () => {
  let events: ReturnType<typeof makeMockEvents>;
  let sessionService: SessionService;

  beforeEach(() => {
    events = makeMockEvents();
    sessionService = makeMockSessionService();
  });

  it('sends on tick when idle', async () => {
    const stop = startInstanceScheduler({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      sessionService,
      events,
      intervalMs: TICK_MS,
    });
    await new Promise((r) => setTimeout(r, TICK_MS + 20));
    stop();
    expect(sessionService.sendUserMessage).toHaveBeenCalledTimes(1);
    const call = (sessionService.sendUserMessage as ReturnType<typeof mock>).mock.calls[0]?.[0];
    expect(call.agentAddress).toBe(ADDR);
    expect(call.sessionId).toBe(SESSION_ID);
    expect(call.tenantId).toBe(TENANT_ID);
  });

  it('skips tick while processing (inference.start received)', async () => {
    const stop = startInstanceScheduler({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      sessionService,
      events,
      intervalMs: TICK_MS,
    });
    events._fire({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      event: { type: 'inference.start', seq: 1, data: { model: 'x' } },
    });
    await new Promise((r) => setTimeout(r, TICK_MS + 20));
    stop();
    expect(sessionService.sendUserMessage).not.toHaveBeenCalled();
  });

  it('resumes sending after inference.done clears processing', async () => {
    const stop = startInstanceScheduler({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      sessionService,
      events,
      intervalMs: TICK_MS,
    });
    events._fire({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      event: { type: 'inference.start', seq: 1, data: { model: 'x' } },
    });
    events._fire({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      event: { type: 'inference.done', seq: 2, data: {} },
    });
    await new Promise((r) => setTimeout(r, TICK_MS + 20));
    stop();
    expect(sessionService.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('stops on reactor.done and sends nothing after', async () => {
    startInstanceScheduler({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      sessionService,
      events,
      intervalMs: TICK_MS,
    });
    events._fire({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      event: { type: 'reactor.done', seq: 1, data: {} },
    });
    await new Promise((r) => setTimeout(r, TICK_MS + 20));
    expect(sessionService.sendUserMessage).not.toHaveBeenCalled();
  });

  it('ignores events from other addresses', async () => {
    const stop = startInstanceScheduler({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      sessionService,
      events,
      intervalMs: TICK_MS,
    });
    events._fire({
      agentAddress: 'other@ws.localhost',
      sessionId: 'other',
      event: { type: 'inference.start', seq: 1, data: { model: 'x' } },
    });
    await new Promise((r) => setTimeout(r, TICK_MS + 20));
    stop();
    expect(sessionService.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('resumes sending after inference.error clears processing', async () => {
    const stop = startInstanceScheduler({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      sessionService,
      events,
      intervalMs: TICK_MS,
    });
    events._fire({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      event: { type: 'inference.start', seq: 1, data: { model: 'x' } },
    });
    events._fire({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      event: { type: 'inference.error', seq: 2, data: {} },
    });
    await new Promise((r) => setTimeout(r, TICK_MS + 20));
    stop();
    expect(sessionService.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('returned stop function cancels the interval', async () => {
    const stop = startInstanceScheduler({
      agentAddress: ADDR,
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      sessionService,
      events,
      intervalMs: TICK_MS,
    });
    stop();
    await new Promise((r) => setTimeout(r, TICK_MS + 20));
    expect(sessionService.sendUserMessage).not.toHaveBeenCalled();
  });
});
