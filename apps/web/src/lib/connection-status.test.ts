/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  INITIAL_REPORTER_STATE,
  isReconnecting,
  RECONNECT_MAX_MS,
  RECONNECT_THROTTLE_MS,
  reduceReporter,
  type ReporterState,
} from "./connection-status";

const ready: ReporterState = {
  hasBeenReady: true,
  droppedAt: null,
  lastReconnectAt: null,
};

describe("reduceReporter", () => {
  it("stays idle while the session is disabled, whatever the phase", () => {
    const d = reduceReporter(ready, "loading", false, 1000);
    expect(d.status).toBe("idle");
    expect(d.reconnect).toBe(false);
  });

  it("reports connected and clears drop memory on ready", () => {
    const d = reduceReporter(
      { hasBeenReady: true, droppedAt: 500, lastReconnectAt: 500 },
      "ready",
      true,
      2000,
    );
    expect(d.status).toBe("connected");
    expect(d.nextState).toEqual({
      hasBeenReady: true,
      droppedAt: null,
      lastReconnectAt: null,
    });
  });

  it("treats the first-ever load as connecting, not a reconnect", () => {
    const d = reduceReporter(INITIAL_REPORTER_STATE, "loading", true, 1000);
    expect(d.status).toBe("connecting");
    expect(d.reconnect).toBe(false);
  });

  it("treats loading after a ready session as reconnecting and opens the window", () => {
    const d = reduceReporter(ready, "loading", true, 1000);
    expect(d.status).toBe("reconnecting");
    expect(d.reconnect).toBe(false);
    expect(d.nextState.droppedAt).toBe(1000);
  });

  it("keeps reconnecting and fires a throttled reconnect while within the window", () => {
    // First error opens the window and fires a reconnect.
    const first = reduceReporter(ready, "error", true, 1000);
    expect(first.status).toBe("reconnecting");
    expect(first.reconnect).toBe(true);
    expect(first.nextState).toEqual({
      hasBeenReady: true,
      droppedAt: 1000,
      lastReconnectAt: 1000,
    });

    // A second error before the throttle elapses stays reconnecting but does
    // NOT fire another reconnect (no hot-loop).
    const soon = reduceReporter(first.nextState, "error", true, 2000);
    expect(soon.status).toBe("reconnecting");
    expect(soon.reconnect).toBe(false);
    expect(soon.nextState.lastReconnectAt).toBe(1000);

    // Once the throttle has elapsed, the next error fires another reconnect.
    const later = reduceReporter(
      soon.nextState,
      "error",
      true,
      1000 + RECONNECT_THROTTLE_MS,
    );
    expect(later.status).toBe("reconnecting");
    expect(later.reconnect).toBe(true);
    expect(later.nextState.lastReconnectAt).toBe(1000 + RECONNECT_THROTTLE_MS);
  });

  it("keeps the overlay up across the whole redeploy, not just one retry", () => {
    // The old behaviour failed on the SECOND error; now it stays reconnecting.
    const first = reduceReporter(ready, "error", true, 1000);
    const second = reduceReporter(
      first.nextState,
      "error",
      true,
      1000 + RECONNECT_THROTTLE_MS,
    );
    expect(second.status).toBe("reconnecting");
  });

  it("falls through to failed only once the drop outlasts the window", () => {
    const dropped: ReporterState = {
      hasBeenReady: true,
      droppedAt: 1000,
      lastReconnectAt: 1000,
    };
    const d = reduceReporter(dropped, "error", true, 1000 + RECONNECT_MAX_MS);
    expect(d.status).toBe("failed");
    expect(d.reconnect).toBe(false);
  });

  it("does not treat provisioning/credential-error as a restart", () => {
    expect(reduceReporter(ready, "provisioning", true, 1000).status).toBe(
      "idle",
    );
    expect(reduceReporter(ready, "credential-error", true, 1000).status).toBe(
      "idle",
    );
  });

  it("treats a fatal launch as terminal — idle, never re-driving a reconnect", () => {
    // Even after a ready session, `fatal` must not spin the overlay or fire a
    // reconnect (unlike `error`, which retries for the redeploy window).
    const d = reduceReporter(ready, "fatal", true, 1000);
    expect(d.status).toBe("idle");
    expect(d.reconnect).toBe(false);
  });

  it("re-arms the reconnect window after the session recovers", () => {
    const errored = reduceReporter(ready, "error", true, 1000);
    const recovered = reduceReporter(errored.nextState, "ready", true, 2000);
    expect(recovered.nextState.droppedAt).toBeNull();
    // A fresh drop long after recovery opens a new window and reconnects.
    const again = reduceReporter(recovered.nextState, "error", true, 999_000);
    expect(again.reconnect).toBe(true);
    expect(again.nextState.droppedAt).toBe(999_000);
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
