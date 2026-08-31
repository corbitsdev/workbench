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
});
