import { getEventListeners } from "node:events";

import { describe, expect, test } from "bun:test";

import { withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  test("resolves with the value once work settles before the deadline", async () => {
    const result = await withTimeout(async () => "ok", 50, "timed out");
    expect(result).toBe("ok");
  });

  test("propagates a rejection work produces on its own", async () => {
    await expect(
      withTimeout(
        async () => {
          throw new Error("boom");
        },
        50,
        "timed out",
      ),
    ).rejects.toThrow("boom");
  });

  test("rejects with the timeout message when work never settles", async () => {
    await expect(
      withTimeout(
        () => new Promise<never>(() => {}),
        10,
        "did not settle within 10ms",
      ),
    ).rejects.toThrow("did not settle within 10ms");
  });

  // CL-7193: the losing promise used to be abandoned outright, with
  // nothing telling it the caller had already given up. `work` now
  // receives the same signal the timeout fires the moment it wins.
  test("aborts the signal work received the moment the deadline wins", async () => {
    let aborted = false;
    let reason: unknown;

    await expect(
      withTimeout(
        (signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reason = signal.reason;
          });
          return new Promise<never>(() => {});
        },
        10,
        "did not settle within 10ms",
      ),
    ).rejects.toThrow("did not settle within 10ms");

    expect(aborted).toBe(true);
    expect(reason).toBeInstanceOf(Error);
  });

  test("never aborts the signal when work settles before the deadline", async () => {
    let sawAbort = false;

    await withTimeout(
      (signal) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
        });
        return Promise.resolve("done");
      },
      50,
      "timed out",
    );

    await Bun.sleep(60);
    expect(sawAbort).toBe(false);
  });

  // CL-7201: a caller with its own reason to give up (a user cancelling a
  // turn) must be able to cut `work` short exactly like a timeout does —
  // without waiting for the timeout's own clock, and without work having
  // to guess which of two signals it was handed.
  describe("an external signal (CL-7201)", () => {
    test("aborts work's signal immediately when the external signal fires, well before the deadline", async () => {
      const external = new AbortController();
      let reason: unknown;

      const promise = withTimeout(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reason = signal.reason;
              reject(signal.reason);
            });
          }),
        10_000,
        "did not settle within 10000ms",
        external.signal,
      );

      const cancelReason = new Error("cancelled by user");
      external.abort(cancelReason);

      await expect(promise).rejects.toThrow("cancelled by user");
      expect(reason).toBe(cancelReason);
    });

    test("an external signal that is already aborted aborts work immediately", async () => {
      const external = new AbortController();
      external.abort(new Error("already gone"));
      let aborted = false;

      await expect(
        withTimeout(
          (signal) =>
            new Promise<never>((_resolve, reject) => {
              if (signal.aborted) {
                aborted = true;
                reject(signal.reason);
                return;
              }
              signal.addEventListener("abort", () => reject(signal.reason));
            }),
          10_000,
          "did not settle within 10000ms",
          external.signal,
        ),
      ).rejects.toThrow("already gone");
      expect(aborted).toBe(true);
    });

    test("the timeout still wins when the external signal never fires", async () => {
      const external = new AbortController();
      await expect(
        withTimeout(
          () => new Promise<never>(() => {}),
          10,
          "did not settle within 10ms",
          external.signal,
        ),
      ).rejects.toThrow("did not settle within 10ms");
    });

    test("work settling on its own is unaffected by an external signal that never fires", async () => {
      const external = new AbortController();
      const result = await withTimeout(
        async () => "ok",
        50,
        "timed out",
        external.signal,
      );
      expect(result).toBe("ok");
    });

    // CL-7201 (Critique finding): the timeout-fired branch never removed
    // its own listener from `externalSignal` — only the two `work`-
    // settles-first branches did. Within one `dispatchTurnBatch`
    // recipient the same cancellation controller's signal is reused
    // across two sequential `withTimeout` calls (`waitUntilFree`, then
    // `dispatchTurn`); a `waitUntilFree` timeout leaving a dangling
    // listener behind means the `dispatchTurn` call's own listener
    // stacks on top of it instead of starting clean.
    test("a timeout win still removes this call's own listener from the external signal", async () => {
      const external = new AbortController();
      await expect(
        withTimeout(
          () => new Promise<never>(() => {}),
          10,
          "did not settle within 10ms",
          external.signal,
        ),
      ).rejects.toThrow("did not settle within 10ms");

      expect(getEventListeners(external.signal, "abort")).toHaveLength(0);
    });
  });
});
