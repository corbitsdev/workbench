import { expect, test } from "bun:test";
import { drainWithTimeout } from "../src/shutdown";

test("resolves drained when the drain completes inside the bound", async () => {
  const outcome = await drainWithTimeout(() => Promise.resolve(), 1_000);
  expect(outcome).toEqual({ kind: "drained" });
});

test("resolves timed-out when the drain outlives the bound", async () => {
  const outcome = await drainWithTimeout(
    () => new Promise<void>(() => undefined),
    10,
  );
  expect(outcome).toEqual({ kind: "timed-out" });
});

test("resolves failed with the thrown error when the drain throws", async () => {
  const error = new Error("drain fault");
  const outcome = await drainWithTimeout(() => Promise.reject(error), 1_000);
  expect(outcome).toEqual({ kind: "failed", error });
});
