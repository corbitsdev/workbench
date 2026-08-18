import type { TurnLatencyStore } from "./latency-store";

// Stage timing for one message run (CL-6257): message-received →
// reactor.start → inference.start → first-token → reply-posted. The
// vendored InferenceEvent stream (`@intx/types/runtime`, see VENDORED.md)
// already carries every timestamp this needs — `message.run.started`'s
// own `data.receivedAt` for the first stage, wall-clock-at-observation for
// the rest — but the vendored event collector
// (`@intx/hub-sessions#createEventCollector`) never persists these event
// types (its `default:` branch drops them) and is not ours to edit. This
// tracker is the product-side seam instead: a structural subset of
// InferenceEvent so it stays decoupled from the vendor type import, wired
// by wrapping the `EventCollectorRegistry` object at its one composition
// root (apps/hub/src/index.ts) the same way `createUsageSink`'s `onUsage`
// forward already is.
type MessageRunStartedData = {
  readonly messageId: string;
  readonly messageRunId: string;
  readonly receivedAt: number;
};

type MessageRunEndedData = {
  readonly messageRunId: string;
  readonly messageId: string;
  readonly status: "completed" | "failed";
};

/**
 * Every InferenceEvent variant carries a `data` field (even the empty-object
 * ones, e.g. `reactor.start`), so this loose shape is structurally
 * satisfied by the real vendor union without importing it — `onEvent`
 * narrows `data` itself once `type` is checked at runtime, the same way a
 * `switch` over the real union's discriminant would.
 */
export type LatencyStageEvent = {
  readonly type: string;
  readonly data?: unknown;
};

type InFlightMessageRun = {
  messageId: string;
  messageRunId: string;
  receivedAt: number;
  reactorStartAt: number | null;
  inferenceStartAt: number | null;
  firstTokenAt: number | null;
};

export type TurnLatencyTrackerDeps = {
  store: TurnLatencyStore;
  generateId: () => string;
  /** Injectable clock — tests supply a fake one. */
  now?: () => number;
};

export type TurnLatencyTracker = {
  /** Mirrors `EventCollectorRegistry.create`'s identity args — the only
   * place tenantId/sessionId are known for a given agentAddress. */
  onSessionCreate(
    agentAddress: string,
    tenantId: string,
    sessionId: string,
  ): void;
  onSessionEnd(agentAddress: string): void;
  onEvent(agentAddress: string, event: LatencyStageEvent): void;
};

/**
 * Observes the same InferenceEvent stream the event collector does,
 * without touching it, and persists one row per message run once it
 * closes. A `reactor.start` seen before its message run has opened yet
 * (the ordinary case: the reactor starts, then dequeues the message that
 * woke it) is stashed per agentAddress and attached to the next run that
 * opens — `reactorStartAt` only ever describes a cold start, so it is
 * correctly null on every later message in a session the reactor kept
 * warm for.
 */
export function createTurnLatencyTracker(
  deps: TurnLatencyTrackerDeps,
): TurnLatencyTracker {
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, { tenantId: string; sessionId: string }>();
  const active = new Map<string, InFlightMessageRun>();
  const pendingReactorStart = new Map<string, number>();

  function onSessionCreate(
    agentAddress: string,
    tenantId: string,
    sessionId: string,
  ): void {
    sessions.set(agentAddress, { tenantId, sessionId });
  }

  function onSessionEnd(agentAddress: string): void {
    sessions.delete(agentAddress);
    active.delete(agentAddress);
    pendingReactorStart.delete(agentAddress);
  }

  function onEvent(agentAddress: string, event: LatencyStageEvent): void {
    const session = sessions.get(agentAddress);
    if (session === undefined) return;

    switch (event.type) {
      case "reactor.start": {
        const inFlight = active.get(agentAddress);
        if (inFlight !== undefined) {
          if (inFlight.reactorStartAt === null) inFlight.reactorStartAt = now();
        } else {
          pendingReactorStart.set(agentAddress, now());
        }
        return;
      }
      case "message.run.started": {
        const data = event.data as MessageRunStartedData;
        const pending = pendingReactorStart.get(agentAddress) ?? null;
        pendingReactorStart.delete(agentAddress);
        active.set(agentAddress, {
          messageId: data.messageId,
          messageRunId: data.messageRunId,
          receivedAt: data.receivedAt,
          reactorStartAt: pending,
          inferenceStartAt: null,
          firstTokenAt: null,
        });
        return;
      }
      case "inference.start": {
        const inFlight = active.get(agentAddress);
        if (inFlight !== undefined && inFlight.inferenceStartAt === null) {
          inFlight.inferenceStartAt = now();
        }
        return;
      }
      case "inference.text.delta": {
        const inFlight = active.get(agentAddress);
        if (inFlight !== undefined && inFlight.firstTokenAt === null) {
          inFlight.firstTokenAt = now();
        }
        return;
      }
      case "message.run.ended": {
        const data = event.data as MessageRunEndedData;
        const inFlight = active.get(agentAddress);
        if (
          inFlight === undefined ||
          inFlight.messageRunId !== data.messageRunId
        ) {
          return;
        }
        active.delete(agentAddress);
        const replyPostedAt = now();
        void deps.store.insertLatency({
          id: deps.generateId(),
          tenantId: session.tenantId,
          sessionId: session.sessionId,
          messageId: inFlight.messageId,
          messageRunId: inFlight.messageRunId,
          status: data.status,
          receivedAt: new Date(inFlight.receivedAt),
          reactorStartAt:
            inFlight.reactorStartAt === null
              ? null
              : new Date(inFlight.reactorStartAt),
          inferenceStartAt:
            inFlight.inferenceStartAt === null
              ? null
              : new Date(inFlight.inferenceStartAt),
          firstTokenAt:
            inFlight.firstTokenAt === null
              ? null
              : new Date(inFlight.firstTokenAt),
          replyPostedAt: new Date(replyPostedAt),
        });
        return;
      }
      default:
        return;
    }
  }

  return { onSessionCreate, onSessionEnd, onEvent };
}
