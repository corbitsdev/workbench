import { expect, test } from "bun:test";

import { createMultistepCredentialsRouter } from "./workflow-run-pack-client";

function makeFrame(agentAddress: string) {
  return {
    type: "credentials.update" as const,
    agentAddress,
    delivery: {
      bindings: [
        {
          handle: "mcp.exa",
          credentialId: "cred_1",
          consumer: "tool:@corbits/mcp-tools",
        },
      ],
      materials: [
        {
          credentialId: "cred_1",
          providerKey: "http",
          origin: "https://mcp.exa.ai/mcp",
          secret: "rotated-secret",
        },
      ],
    },
  };
}

test("tryRoute reports false for an address with no registered handler", async () => {
  const router = createMultistepCredentialsRouter();
  expect(await router.tryRoute(makeFrame("ins_dep_1@example.com"))).toBe(false);
});

test("tryRoute dispatches the frame's delivery to the handler", async () => {
  const router = createMultistepCredentialsRouter();
  const seen: { delivery: unknown }[] = [];
  router.register("ins_dep_1@example.com", async (args) => {
    seen.push(args);
  });
  const frame = makeFrame("ins_dep_1@example.com");
  expect(await router.tryRoute(frame)).toBe(true);
  expect(seen).toEqual([{ delivery: frame.delivery }]);
});

test("a handler rejection propagates to the caller", async () => {
  const router = createMultistepCredentialsRouter();
  router.register("ins_dep_1@example.com", () =>
    Promise.reject(new Error("child rejected credentials-updated")),
  );
  await expect(
    router.tryRoute(makeFrame("ins_dep_1@example.com")),
  ).rejects.toThrow(/child rejected credentials-updated/);
});

test("unregister stops routing for the address", async () => {
  const router = createMultistepCredentialsRouter();
  router.register("ins_dep_1@example.com", async () => undefined);
  router.unregister("ins_dep_1@example.com");
  expect(await router.tryRoute(makeFrame("ins_dep_1@example.com"))).toBe(false);
});
