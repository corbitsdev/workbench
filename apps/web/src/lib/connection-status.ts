/**
 * Connection-status derivation for the reconnecting overlay.
 *
 * A hub/sidecar restart (a redeploy) briefly drops a live Myra session. Rather
 * than fall straight through to a per-panel "Try again" error, we cover the app
 * with a reassuring "downloading a new update" splash while the session heals,
 * then step aside if it cannot.
 *
 * The signal is the Myra session phase, plus remembered facts per session:
 * whether it was ever `ready` (so a first-ever load is NOT treated as a restart)
 * and when the current drop began. A redeploy is not brief — the sidecar can be
 * unreachable for a minute or more — so the overlay must persist and keep
 * retrying for the length of a real redeploy, not a single attempt. It falls
 * through to the manual "Try again" only after the drop outlasts
 * `RECONNECT_MAX_MS` (a genuine outage, not a restart).
 */

export type MyraPhase =
  | "loading"
  | "provisioning"
  | "credential-error"
  | "ready"
  | "error";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export interface ReporterState {
  /** Set once the session reaches `ready`; a restart is only meaningful after. */
  hasBeenReady: boolean;
  /** Timestamp (ms) the current drop began, or null when healthy. */
  droppedAt: number | null;
  /** Timestamp (ms) of the last auto-reconnect we fired, for throttling. */
  lastReconnectAt: number | null;
}

export interface ReporterDecision {
  status: ConnectionStatus;
  nextState: ReporterState;
  /** True when the caller should trigger `session.reconnect` (throttled). */
  reconnect: boolean;
}

export const INITIAL_REPORTER_STATE: ReporterState = {
  hasBeenReady: false,
  droppedAt: null,
  lastReconnectAt: null,
};

/**
 * The reconnect window: how long a dropped-but-was-ready session keeps the
 * overlay up and keeps auto-retrying before giving up to the manual "Try again".
 * Sized to outlast a real redeploy (hub/sidecar restart + reconnect settle),
 * not a single retry.
 */
export const RECONNECT_MAX_MS = 180_000;

/** Minimum gap between auto-reconnects, so a fast-failing connect can't hot-loop. */
export const RECONNECT_THROTTLE_MS = 4_000;

/**
 * Fold a new phase into a reporter's remembered state, returning the status the
 * overlay should see and whether to kick a reconnect. `now` is injected for
 * testability.
 *
 * - `ready` clears the drop memory (a fresh healthy session).
 * - before the first `ready`, everything is plain `connecting` — no overlay.
 * - after a `ready`, `loading` is the internal retry loop → `reconnecting`, and
 *   it opens the drop window if one is not already open.
 * - after a `ready`, `error` keeps the overlay up and fires a throttled reconnect
 *   for as long as the drop is within `RECONNECT_MAX_MS`; past that it is a real
 *   outage → `failed` (overlay hides, the panel's own "Try again" takes over).
 * - `provisioning`/`credential-error` are setup problems, not restarts → `idle`.
 */
export function reduceReporter(
  prev: ReporterState,
  phase: MyraPhase,
  enabled: boolean,
  now: number,
): ReporterDecision {
  if (!enabled) {
    return { status: "idle", nextState: prev, reconnect: false };
  }
  if (phase === "ready") {
    return {
      status: "connected",
      nextState: { hasBeenReady: true, droppedAt: null, lastReconnectAt: null },
      reconnect: false,
    };
  }
  if (!prev.hasBeenReady) {
    return { status: "connecting", nextState: prev, reconnect: false };
  }
  if (phase === "loading") {
    return {
      status: "reconnecting",
      nextState: { ...prev, droppedAt: prev.droppedAt ?? now },
      reconnect: false,
    };
  }
  if (phase === "error") {
    const droppedAt = prev.droppedAt ?? now;
    if (now - droppedAt >= RECONNECT_MAX_MS) {
      return { status: "failed", nextState: { ...prev, droppedAt }, reconnect: false };
    }
    const shouldReconnect =
      prev.lastReconnectAt === null ||
      now - prev.lastReconnectAt >= RECONNECT_THROTTLE_MS;
    return {
      status: "reconnecting",
      nextState: {
        ...prev,
        droppedAt,
        lastReconnectAt: shouldReconnect ? now : prev.lastReconnectAt,
      },
      reconnect: shouldReconnect,
    };
  }
  return { status: "idle", nextState: prev, reconnect: false };
}

/** The overlay is warranted while any active session is reconnecting. */
export function isReconnecting(statuses: Iterable<ConnectionStatus>): boolean {
  for (const s of statuses) {
    if (s === "reconnecting") return true;
  }
  return false;
}

/**
 * How long a session must stay reconnecting before the overlay appears. Momentary
 * SSE blips (the event stream reconnects silently within a second or two) must
 * never flash the splash — only a real redeploy-length outage should.
 */
export const RECONNECT_OVERLAY_DELAY_MS = 2500;
