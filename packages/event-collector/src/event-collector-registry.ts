// Registry of active event collectors, keyed by agent address, with per-agent
// event serialization.
//
// Provenance / why this exists (CL-1656): Interchange's
// `@intx/hub-sessions` registry dispatches events fire-and-forget
// (`collector.onEvent(event)` without awaiting), so when `inference.start`
// and `inference.done` arrive back-to-back the turn row from `start` has not
// committed when `done` writes its `turn_part` rows — a foreign-key violation
// that drops the whole `inference.done` persist (missing thinking/text,
// out-of-order, "no response"). `@intx/hub-sessions` does not export the
// per-collector primitive, so we cannot wrap it thinly from the hub; this
// package owns the collector (an unchanged copy of upstream) and adds the one
// thing that was missing: a per-agent promise queue so events for a given
// agent apply strictly in order. Per-address keying preserves cross-agent
// concurrency. If this proves out it can be upstreamed into interchange.

import type { DB } from '@intx/db';
import type { InferenceEvent } from '@intx/types/runtime';
import type { SessionStatus } from '@intx/types';
import { getLogger } from '@intx/log';

import { createEventCollector, type EventCollector, type TurnFinalized } from './event-collector';

const log = getLogger(['hub', 'event-collector-registry']);

export type EventCollectorRegistry = {
  create(agentAddress: string, tenantId: string, sessionId: string, instanceId: string): void;
  dispatch(agentAddress: string, event: InferenceEvent): void;
  abandon(agentAddress: string): void;
  has(agentAddress: string): boolean;
  getStatus(agentAddress: string): SessionStatus | undefined;
  getAccumulatedText(agentAddress: string): string | undefined;
  getCurrentTurnId(agentAddress: string): string | null | undefined;
  getLastTurnId(agentAddress: string): string | null | undefined;
};

export type EventCollectorRegistryConfig = {
  db: DB['db'];
  onTurnFinalized?: (agentAddress: string, turn: TurnFinalized) => void;
};

export function deriveStatus(event: InferenceEvent): SessionStatus | null {
  switch (event.type) {
    case 'inference.start':
      return { status: 'busy' };
    case 'connector.reply':
      return { status: 'idle' };
    case 'reactor.gate.blocked':
      if (event.data.reason === 'approval') return { status: 'waiting_approval' };
      return null;
    case 'reactor.gate.cleared':
      return { status: 'busy' };
    case 'reactor.done':
      return { status: 'idle' };
    case 'reactor.error':
      if (event.data.fatal) return { status: 'idle' };
      return null;
    default:
      return null;
  }
}

export function createEventCollectorRegistry(
  config: EventCollectorRegistryConfig
): EventCollectorRegistry {
  const { db, onTurnFinalized } = config;
  const collectors = new Map<string, EventCollector>();
  const statuses = new Map<string, SessionStatus>();
  // Per-agent serialization tail. Each agent's events apply in order by
  // chaining onto its previous task; the turn-row insert from one event
  // therefore commits before the next event's parts are written, which is the
  // whole point of this package (CL-1656). Different agents never share a tail,
  // so they proceed concurrently.
  const queues = new Map<string, Promise<void>>();

  function enqueue(agentAddress: string, task: () => Promise<void>): void {
    const prev = queues.get(agentAddress) ?? Promise.resolve();
    const next = prev.then(task).finally(() => {
      // Drop the tail once drained so the map does not grow unbounded.
      if (queues.get(agentAddress) === next) {
        queues.delete(agentAddress);
      }
    });
    queues.set(agentAddress, next);
  }

  function create(
    agentAddress: string,
    tenantId: string,
    sessionId: string,
    instanceId: string
  ): void {
    if (collectors.has(agentAddress)) {
      log.warn`Collector already exists for ${agentAddress}, replacing`;
      abandon(agentAddress);
    }

    const collector = createEventCollector({
      db,
      sessionId,
      instanceId,
      tenantId,
      ...(onTurnFinalized
        ? {
            onTurnFinalized: (turn: TurnFinalized) => onTurnFinalized(agentAddress, turn),
          }
        : {}),
    });
    collectors.set(agentAddress, collector);
    statuses.set(agentAddress, { status: 'idle' });
  }

  function removeCollector(agentAddress: string): void {
    collectors.delete(agentAddress);
    statuses.delete(agentAddress);
  }

  function dispatch(agentAddress: string, event: InferenceEvent): void {
    const collector = collectors.get(agentAddress);
    if (collector === undefined) {
      return;
    }

    const derived = deriveStatus(event);
    if (derived !== null) {
      statuses.set(agentAddress, derived);
    }

    const isTerminal =
      event.type === 'reactor.done' || (event.type === 'reactor.error' && event.data.fatal);

    enqueue(agentAddress, async () => {
      try {
        await collector.onEvent(event);
      } catch (err: unknown) {
        log.warn`Failed to persist event ${event.type} seq=${String(event.seq)} for ${agentAddress}: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (isTerminal) {
        removeCollector(agentAddress);
      }
    });
  }

  function abandon(agentAddress: string): void {
    const collector = collectors.get(agentAddress);
    if (collector === undefined) return;

    // Remove immediately so `has()` reflects the teardown at once (matching
    // upstream). Events already queued before this point still drain first
    // (they captured the collector), so the abandon finalizes a turn that is
    // not mid-write. Events dispatched *after* this find no collector and are
    // dropped — same as upstream, and the disconnect path that triggers abandon
    // should not produce more events anyway.
    removeCollector(agentAddress);
    enqueue(agentAddress, async () => {
      try {
        await collector.abandon();
      } catch (err: unknown) {
        log.warn`Failed to abandon collector for ${agentAddress}: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
  }

  function has(agentAddress: string): boolean {
    return collectors.has(agentAddress);
  }

  function getStatus(agentAddress: string): SessionStatus | undefined {
    return statuses.get(agentAddress);
  }

  function getAccumulatedText(agentAddress: string): string | undefined {
    return collectors.get(agentAddress)?.getAccumulatedText();
  }

  function getCurrentTurnId(agentAddress: string): string | null | undefined {
    return collectors.get(agentAddress)?.getCurrentTurnId();
  }

  function getLastTurnId(agentAddress: string): string | null | undefined {
    return collectors.get(agentAddress)?.getLastTurnId();
  }

  return {
    create,
    dispatch,
    abandon,
    has,
    getStatus,
    getAccumulatedText,
    getCurrentTurnId,
    getLastTurnId,
  };
}
