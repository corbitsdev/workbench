import { describe, expect, test } from "bun:test";
import { createCommandRegistry } from "../src/registry";
import {
  dispatchAtCommand,
  dispatchSlashCommand,
  resolveAtCommand,
} from "../src/dispatch";

const CTX = { tenantId: "t1", principalId: "p1", workbenchId: "c1" };

describe("dispatchSlashCommand", () => {
  test("returns undefined for text that is not slash-shaped", async () => {
    const registry = createCommandRegistry();
    expect(await dispatchSlashCommand(registry, "hello", CTX)).toBeUndefined();
  });

  test("unknown command dispatches a loud message", async () => {
    const registry = createCommandRegistry();
    expect(await dispatchSlashCommand(registry, "/nope", CTX)).toEqual({
      type: "message",
      text: "Unknown command: /nope",
    });
  });

  test("runs the resolved command's handler with the parsed args and context", async () => {
    const registry = createCommandRegistry();
    let seenArgs: string | undefined;
    let seenCtx: typeof CTX | undefined;
    registry.registerCommand({
      name: "echo",
      description: "echoes",
      handler: (args, ctx) => {
        seenArgs = args;
        seenCtx = ctx;
        return { type: "message", text: args };
      },
    });

    const result = await dispatchSlashCommand(registry, "/echo hi there", CTX);
    expect(result).toEqual({ type: "message", text: "hi there" });
    expect(seenArgs).toBe("hi there");
    expect(seenCtx).toEqual(CTX);
  });
});

describe("resolveAtCommand / dispatchAtCommand", () => {
  test("resolveAtCommand is undefined when the name is not a registered command", async () => {
    const registry = createCommandRegistry();
    expect(
      await resolveAtCommand(registry, "@someone hi", "t1"),
    ).toBeUndefined();
  });

  test("resolveAtCommand finds a registered command's name and args", async () => {
    const registry = createCommandRegistry();
    registry.registerCommand({
      name: "assistant",
      description: "starts the assistant",
      handler: () => ({ type: "noop" }),
    });
    expect(await resolveAtCommand(registry, "@assistant do it", "t1")).toEqual({
      name: "assistant",
      args: "do it",
    });
  });

  test("dispatchAtCommand runs the workflow-command handler with passthrough args", async () => {
    const registry = createCommandRegistry();
    registry.registerCommand({
      name: "assistant",
      description: "starts the assistant",
      handler: (_args) => ({
        type: "workflow-started",
        definitionId: "def-1",
        address: "ins_1@t.test",
        handle: "assistant",
      }),
    });
    const result = await dispatchAtCommand(
      registry,
      "@assistant summarize this",
      CTX,
    );
    expect(result).toEqual({
      type: "workflow-started",
      definitionId: "def-1",
      address: "ins_1@t.test",
      handle: "assistant",
    });
  });
});
