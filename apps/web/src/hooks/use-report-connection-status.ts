import { useEffect, useId, useRef } from "react";
import { useConnectionReporter } from "../lib/connection-status-context";
import {
  INITIAL_REPORTER_STATE,
  reduceReporter,
  type MyraPhase,
  type ReporterState,
} from "../lib/connection-status";

/**
 * Reports a Myra session's connection status to the app-level provider so the
 * reconnecting overlay can cover the app during a restart. Called once inside
 * `useMyraSession`, so every surface that opens a session participates with no
 * extra wiring. Fires throttled automatic `reconnect()`s while a previously-ready
 * session is dropped, healing it without a user click for the length of a real
 * redeploy before falling through to the manual "Try again".
 *
 * `identityKey` is the session's identity (instance + tenant). When it changes
 * the user has navigated to a *different* session, not lost the current one, so
 * the drop memory resets — otherwise a slow thread switch (a cold sidecar takes
 * seconds) would be misread as a restart and wrongly cover the app.
 */
export function useReportConnectionStatus(
  phase: MyraPhase,
  enabled: boolean,
  reconnect: () => void,
  identityKey: string | null,
): void {
  const report = useConnectionReporter();
  const id = useId();
  const stateRef = useRef<ReporterState>(INITIAL_REPORTER_STATE);
  // Reset drop memory when the session identity changes: a new instance/tenant
  // is a fresh session, not a reconnect of the old one. Adjusting the ref during
  // render keeps the effect below in sync within the same commit.
  const identityRef = useRef(identityKey);
  if (identityRef.current !== identityKey) {
    identityRef.current = identityKey;
    stateRef.current = INITIAL_REPORTER_STATE;
  }
  // Keep the latest reconnect callback without re-running the effect when the
  // hook's caller recreates it every render.
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  // A null identity means there is no concrete session to watch (the caller is
  // still resolving a thread/workbench); report idle so a frozen phase can never
  // leave the overlay stuck up.
  const active = enabled && identityKey !== null;

  useEffect(() => {
    const decision = reduceReporter(
      stateRef.current,
      phase,
      active,
      Date.now(),
    );
    stateRef.current = decision.nextState;
    report(id, decision.status);
    if (decision.reconnect) reconnectRef.current();
  }, [phase, active, report, id, identityKey]);

  useEffect(() => {
    return () => report(id, "gone");
  }, [report, id]);
}
