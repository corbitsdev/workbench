/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  INITIAL_REPORTER_STATE,
  isReconnecting,
  reduceReporter,
  type ReporterState,
} from "./connection-status";

const ready: ReporterState = { hasBeenReady: true, autoRetried: false };

describe("reduceReporter", () => {
  it("stays idle while the session is disabled, whatever the phase", () => {
    const d = reduceReporter(ready, "loading", false);
    expect(d.status).toBe("idle");
    expect(d.reconnect).toBe(false);
  });

  it("reports connected and clears drop memory on ready", () => {
    const d = reduceReporter(
      { hasBeenReady: true, autoRetried: true },
      "ready",
      true,
    );
    expect(d.status).toBe("connected");
    expect(d.nextState).toEqual({ hasBeenReady: true, autoRetried: false });
  });

  it("treats the first-ever load as connecting, not a reconnect", () => {
    const d = reduceReporter(INITIAL_REPORTER_STATE, "loading", true);
    expect(d.status).toBe("connecting");
    expect(d.reconnect).toBe(false);
  });

  it("treats loading after a ready session as reconnecting", () => {
    const d = reduceReporter(ready, "loading", true);
    expect(d.status).toBe("reconnecting");
    expect(d.reconnect).toBe(false);
  });

  it("fires exactly one auto-reconnect on the first error after ready", () => {
    const first = reduceReporter(ready, "error", true);
    expect(first.status).toBe("reconnecting");
    expect(first.reconnect).toBe(true);
    expect(first.nextState.autoRetried).toBe(true);

    // A second consecutive error is a real outage: fall through, do not loop.
    const second = reduceReporter(first.nextState, "error", true);
    expect(second.status).toBe("failed");
    expect(second.reconnect).toBe(false);
  });

  it("does not treat provisioning/credential-error as a restart", () => {
    expect(reduceReporter(ready, "provisioning", true).status).toBe("idle");
    expect(reduceReporter(ready, "credential-error", true).status).toBe("idle");
  });

  it("re-arms the auto-reconnect after the session recovers", () => {
    const errored = reduceReporter(ready, "error", true); // autoRetried = true
    const recovered = reduceReporter(errored.nextState, "ready", true);
    expect(recovered.nextState.autoRetried).toBe(false);
    // A fresh drop after recovery gets its own auto-reconnect.
    const again = reduceReporter(recovered.nextState, "error", true);
    expect(again.reconnect).toBe(true);
  });
});

describe("isReconnecting", () => {
  it("is true when any session is reconnecting", () => {
    expect(isReconnecting(["connected", "reconnecting", "idle"])).toBe(true);
  });
  it("is false when none are", () => {
    expect(isReconnecting(["connected", "connecting", "failed"])).toBe(false);
    expect(isReconnecting([])).toBe(false);
  });
});
