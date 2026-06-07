import { getLogger } from '@intx/log';
import { generateId } from '@intx/hub-common';
import { generateKeyPair, createNodeCrypto } from '@intx/crypto-node';
import type { SessionService, SidecarEventEmitter } from '@intx/hub-sessions';

const log = getLogger(['agent-scheduler']);

export type InstanceSchedulerOptions = {
  /** Agent address (e.g. "inst-abc@workspace.localhost"). */
  agentAddress: string;
  /** Active session ID for this instance. */
  sessionId: string;
  /** Tenant that owns this instance. */
  tenantId: string;
  /** Used to send the periodic sync message. */
  sessionService: SessionService;
  /** Sidecar event emitter — used to observe inference state and reactor.done. */
  events: SidecarEventEmitter;
  /** Polling interval in ms. Defaults to 60 000. */
  intervalMs?: number;
};

/**
 * Start a per-instance scheduler for an agent session. Sends a "sync" trigger
 * on each interval tick, but skips the tick when the agent is mid-inference.
 * Stops automatically when the agent's reactor emits reactor.done. Returns a
 * cleanup function for early teardown (e.g. hub shutdown or session end).
 */
export function startInstanceScheduler(opts: InstanceSchedulerOptions): () => void {
  const { agentAddress, sessionId, tenantId, sessionService, events, intervalMs = 60_000 } = opts;

  log.info('Starting instance scheduler', { agentAddress, sessionId });

  let processing = false;
  let stopped = false;

  const cryptoPromise = generateKeyPair().then((kp) => createNodeCrypto(kp));

  const off = events.on('agent.event', (payload) => {
    if (payload.agentAddress !== agentAddress) return;

    const event = payload.event as { type?: string };
    if (event.type === 'inference.start') {
      processing = true;
    } else if (event.type === 'inference.done' || event.type === 'inference.error') {
      processing = false;
    } else if (event.type === 'reactor.done') {
      log.info('Reactor done — stopping instance scheduler', { agentAddress });
      stop();
    }
  });

  const timer = setInterval(() => {
    if (stopped || processing) return;
    void (async () => {
      const mailId = generateId('sessionMail');
      const cryptoProvider = await cryptoPromise;
      if (stopped) return;
      try {
        await sessionService.sendUserMessage({
          agentAddress,
          from: 'scheduler@system',
          messageId: `<${mailId}@system>`,
          date: new Date(),
          content: 'sync',
          sessionId,
          tenantId,
          cryptoProvider,
        });
        log.debug('Sync trigger sent', { agentAddress });
      } catch (err) {
        log.error('Sync trigger failed', {
          agentAddress,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })();
  }, intervalMs);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    off();
    log.info('Instance scheduler stopped', { agentAddress });
  }

  return stop;
}
