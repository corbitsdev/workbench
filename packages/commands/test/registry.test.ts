import { describe, expect, test } from "bun:test";
import { createCommandRegistry } from "../src/registry";
import type { CommandDefinition } from "../src/registry";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function noopHandler(): { type: "noop" } {
  return { type: "noop" };
}

describe("createCommandRegistry", () => {
  test("registers and looks up a static command", async () => {
    const registry = createCommandRegistry();
    const definition: CommandDefinition = {
      name: "help",
      description: "Show help",
      handler: noopHandler,
    };
    registry.registerCommand(definition);

    expect(await registry.getCommand("help", TENANT_A)).toBe(definition);
    expect(await registry.listCommands(TENANT_A)).toEqual([definition]);
  });

  test("rejects registering the same static name twice", () => {
    const registry = createCommandRegistry();
    registry.registerCommand({
      name: "help",
      description: "Show help",
      handler: noopHandler,
    });
    expect(() =>
      registry.registerCommand({
        name: "help",
        description: "Show help again",
        handler: noopHandler,
      }),
    ).toThrow(/already registered/);
  });

  test("listCommands excludes hidden commands but getCommand still resolves them", async () => {
    const registry = createCommandRegistry();
    registry.registerCommand({
      name: "visible",
      description: "shown",
      handler: noopHandler,
    });
    registry.registerCommand({
      name: "secret",
      description: "not shown",
      hidden: true,
      handler: noopHandler,
    });

    const listed = await registry.listCommands(TENANT_A);
    expect(listed.map((c) => c.name)).toEqual(["visible"]);
    expect((await registry.getCommand("secret", TENANT_A))?.name).toBe(
      "secret",
    );
  });

  test("a plugin's commands are scoped per tenant", async () => {
    const registry = createCommandRegistry();
    registry.registerCommandPlugin(async ({ tenantId }) => [
      {
        name: `wf-${tenantId}`,
        description: "a per-tenant workflow command",
        handler: noopHandler,
      },
    ]);

    const listedA = await registry.listCommands(TENANT_A);
    const listedB = await registry.listCommands(TENANT_B);
    expect(listedA.map((c) => c.name)).toEqual([`wf-${TENANT_A}`]);
    expect(listedB.map((c) => c.name)).toEqual([`wf-${TENANT_B}`]);
  });

  test("a static command shadows a plugin command of the same name", async () => {
    const registry = createCommandRegistry();
    registry.registerCommandPlugin(async () => [
      { name: "echo", description: "plugin echo", handler: noopHandler },
    ]);
    registry.registerCommand({
      name: "echo",
      description: "static echo",
      handler: noopHandler,
    });

    const resolved = await registry.getCommand("echo", TENANT_A);
    expect(resolved?.description).toBe("static echo");
  });

  test("listCommands sorts by name", async () => {
    const registry = createCommandRegistry();
    registry.registerCommand({
      name: "zeta",
      description: "z",
      handler: noopHandler,
    });
    registry.registerCommand({
      name: "alpha",
      description: "a",
      handler: noopHandler,
    });
    expect((await registry.listCommands(TENANT_A)).map((c) => c.name)).toEqual([
      "alpha",
      "zeta",
    ]);
  });
});
