/**
 * Connection-status derivation for the reconnecting overlay.
 *
 * A hub/sidecar restart (a redeploy) briefly drops a live Myra session. Rather
 * than fall straight through to a per-panel "Try again" error, we cover the app
 * with a reassuring "downloading a new update" splash while the session heals,
 * then step aside if it cannot.
 *
 * The signal is the Myra session phase, plus two remembered facts per session:
 * whether it was ever `ready` (so a first-ever load is NOT treated as a restart)
 * and whether we have already spent our one automatic reconnect (so a genuine
 * outage falls through to the manual error instead of looping the overlay).
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
  /** Set when we have fired our single automatic reconnect for this drop. */
  autoRetried: boolean;
}

export interface ReporterDecision {
  status: ConnectionStatus;
  nextState: ReporterState;
  /** True exactly once per drop — the caller should trigger `session.reconnect`. */
  reconnect: boolean;
}

export const INITIAL_REPORTER_STATE: ReporterState = {
  hasBeenReady: false,
  autoRetried: false,
};

/**
 * Fold a new phase into a reporter's remembered state, returning the status the
 * overlay should see and whether to kick a one-shot reconnect.
 *
 * - `ready` clears the drop memory (a fresh healthy session).
 * - before the first `ready`, everything is plain `connecting` — no overlay.
 * - after a `ready`, a `loading` phase is the internal retry loop → `reconnecting`.
 * - after a `ready`, the first `error` fires one auto reconnect and shows the
 *   overlay; a second consecutive `error` is a real outage → `failed` (overlay
 *   hides, the panel's own "Try again" takes over).
 * - `provisioning`/`credential-error` are setup problems, not restarts → `idle`.
 */
export function reduceReporter(
  prev: ReporterState,
  phase: MyraPhase,
  enabled: boolean,
): ReporterDecision {
  if (!enabled) {
    return { status: "idle", nextState: prev, reconnect: false };
  }
  if (phase === "ready") {
    return {
      status: "connected",
      nextState: { hasBeenReady: true, autoRetried: false },
      reconnect: false,
    };
  }
  if (!prev.hasBeenReady) {
    return { status: "connecting", nextState: prev, reconnect: false };
  }
  if (phase === "loading") {
    return { status: "reconnecting", nextState: prev, reconnect: false };
  }
  if (phase === "error") {
    if (!prev.autoRetried) {
      return {
        status: "reconnecting",
        nextState: { ...prev, autoRetried: true },
        reconnect: true,
      };
    }
    return { status: "failed", nextState: prev, reconnect: false };
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
