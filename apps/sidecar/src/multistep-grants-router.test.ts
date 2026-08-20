import { expect, test } from "bun:test";

import { createMultistepGrantsRouter } from "./workflow-run-pack-client";

function makeFrame(agentAddress: string) {
  return {
    type: "run.grants" as const,
    agentAddress,
    runId: "run-1",
    stepGrants: [{ resource: "tool:echo", action: "invoke" }],
  };
}

test("tryRoute reports false for an address with no registered handler", async () => {
  const router = createMultistepGrantsRouter();
  expect(await router.tryRoute(makeFrame("ins_dep_1@example.com"))).toBe(false);
});

test("tryRoute dispatches the frame's runId and stepGrants to the handler", async () => {
  const router = createMultistepGrantsRouter();
  const seen: { runId: string; stepGrants: readonly unknown[] }[] = [];
  router.register("ins_dep_1@example.com", async (args) => {
    seen.push(args);
  });
  expect(await router.tryRoute(makeFrame("ins_dep_1@example.com"))).toBe(true);
  expect(seen).toEqual([
    {
      runId: "run-1",
      stepGrants: [{ resource: "tool:echo", action: "invoke" }],
    },
  ]);
});

test("a handler rejection propagates to the caller", async () => {
  const router = createMultistepGrantsRouter();
  router.register("ins_dep_1@example.com", () =>
    Promise.reject(new Error("durable write failed")),
  );
  await expect(
    router.tryRoute(makeFrame("ins_dep_1@example.com")),
  ).rejects.toThrow(/durable write failed/);
});

test("unregister stops routing for the address", async () => {
  const router = createMultistepGrantsRouter();
  router.register("ins_dep_1@example.com", async () => undefined);
  router.unregister("ins_dep_1@example.com");
  expect(await router.tryRoute(makeFrame("ins_dep_1@example.com"))).toBe(false);
});
