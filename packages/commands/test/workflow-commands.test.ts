import { describe, expect, test } from "bun:test";
import { createCommandRegistry } from "../src/registry";
import { createWorkflowCommandPlugin } from "../src/workflow-commands";
import { dispatchSlashCommand } from "../src/dispatch";

const CTX = {
  tenantId: "tenant-1",
  principalId: "principal-1",
  workbenchId: "workbench-1",
};

describe("createWorkflowCommandPlugin", () => {
  test("exposes each invitable definition as a command named after it", async () => {
    const registry = createCommandRegistry();
    registry.registerCommandPlugin(
      createWorkflowCommandPlugin({
        listInvitableDefinitions: async () => [
          { id: "def-echo", name: "echo" },
          { id: "def-assistant", name: "assistant" },
        ],
        startWorkflow: async () => ({
          handle: "unused",
          address: "unused@t.test",
        }),
      }),
    );

    const listed = await registry.listCommands(CTX.tenantId);
    expect(listed.map((c) => c.name).sort()).toEqual(["assistant", "echo"]);
    expect(listed.find((c) => c.name === "echo")?.argumentHint).toBe("[input]");
  });

  test("passes the invocation's raw args and calling context through to startWorkflow", async () => {
    const registry = createCommandRegistry();
    const startCalls: unknown[] = [];
    registry.registerCommandPlugin(
      createWorkflowCommandPlugin({
        listInvitableDefinitions: async () => [
          { id: "def-echo", name: "echo" },
        ],
        startWorkflow: async (input) => {
          startCalls.push(input);
          return { handle: "echo", address: "ins_1@tenant.test" };
        },
      }),
    );

    const result = await dispatchSlashCommand(
      registry,
      "/echo summarize the thread",
      CTX,
    );

    expect(startCalls).toEqual([
      {
        tenantId: CTX.tenantId,
        principalId: CTX.principalId,
        workbenchId: CTX.workbenchId,
        definitionId: "def-echo",
        args: "summarize the thread",
      },
    ]);
    expect(result).toEqual({
      type: "workflow-started",
      definitionId: "def-echo",
      address: "ins_1@tenant.test",
      handle: "echo",
    });
  });

  test("unknown workflow name still dispatches the loud unknown-command message", async () => {
    const registry = createCommandRegistry();
    registry.registerCommandPlugin(
      createWorkflowCommandPlugin({
        listInvitableDefinitions: async () => [],
        startWorkflow: async () => {
          throw new Error("must not be called");
        },
      }),
    );

    const result = await dispatchSlashCommand(registry, "/nonexistent", CTX);
    expect(result).toEqual({
      type: "message",
      text: "Unknown command: /nonexistent",
    });
  });
});
