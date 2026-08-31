import { expect, test } from "bun:test";
import { drainHubServer, drainWithTimeout, shutdownHub } from "./shutdown";

test("drainWithTimeout resolves drained when the drain completes inside the bound", async () => {
  const outcome = await drainWithTimeout(() => Promise.resolve(), 1_000);
  expect(outcome).toEqual({ kind: "drained" });
});

test("drainWithTimeout resolves timed-out when the drain outlives the bound", async () => {
  const outcome = await drainWithTimeout(
    () => new Promise<void>(() => undefined),
    10,
  );
  expect(outcome).toEqual({ kind: "timed-out" });
});

test("drainWithTimeout resolves failed with the thrown error when the drain throws", async () => {
  const error = new Error("drain fault");
  const outcome = await drainWithTimeout(() => Promise.reject(error), 1_000);
  expect(outcome).toEqual({ kind: "failed", error });
});

test("shutdownHub exits 0 when the drain resolves inside the bound", async () => {
  let exitCode: number | undefined;
  const reported: unknown[] = [];
  await shutdownHub({
    drain: () => Promise.resolve(),
    timeoutMs: 1_000,
    exit: (code) => {
      exitCode = code;
    },
    report: (error) => {
      reported.push(error);
      return "unused-ref-id";
    },
  });
  expect(exitCode).toBe(0);
  expect(reported).toEqual([]);
});

test("shutdownHub exits non-zero and reports the cause when the drain never settles", async () => {
  let exitCode: number | undefined;
  const reported: unknown[] = [];
  await shutdownHub({
    drain: () => new Promise<void>(() => undefined),
    timeoutMs: 10,
    exit: (code) => {
      exitCode = code;
    },
    report: (error) => {
      reported.push(error);
      return "unused-ref-id";
    },
  });
  expect(exitCode).toBe(1);
  expect(reported).toHaveLength(1);
  expect(reported[0]).toBeInstanceOf(Error);
  expect((reported[0] as Error).message).toContain("exceeded 10ms");
});

test("shutdownHub exits non-zero and reports the cause when the drain rejects", async () => {
  let exitCode: number | undefined;
  const reported: unknown[] = [];
  const error = new Error("close fault");
  await shutdownHub({
    drain: () => Promise.reject(error),
    timeoutMs: 1_000,
    exit: (code) => {
      exitCode = code;
    },
    report: (reportedError) => {
      reported.push(reportedError);
      return "unused-ref-id";
    },
  });
  expect(exitCode).toBe(1);
  expect(reported).toEqual([error]);
});

test("drainHubServer waits for idle handlers then force-stops", async () => {
  const order: string[] = [];
  await drainHubServer({
    whenRequestsIdle: async () => {
      order.push("idle");
    },
    stop: (force) => {
      order.push(force ? "stop-force" : "stop");
    },
    close: async () => {
      order.push("close");
    },
  });
  expect(order).toEqual(["idle", "stop-force", "close"]);
});
