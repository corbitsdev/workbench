// `startWorkflowCommand` is the `WorkflowCommandDeps.startWorkflow`
// implementation `@corbits/chat` hands `@corbits/commands`' built-in
// workflow-command registrar: invite-then-send, sharing the same
// `launchAndJoinAgent` core as `POST .../invite`.
import { describe, expect, test } from "bun:test";
import { startWorkflowCommand } from "../src/workbench-service";
import { createInMemoryChatStore } from "../src/store";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { fakePlatform, TENANT } from "./test-support";

describe("startWorkflowCommand", () => {
  test("invites the definition and sends the args as the new agent's opening mail", async () => {
    const store = createInMemoryChatStore();
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "Echo" }],
    });
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
      settings: { "chat/kind": "workbench", "chat/participants": [] },
      updatedBy: "prn_alice",
    });

    const result = await startWorkflowCommand(
      {
        store,
        platform,
        roomMessages: createInMemoryRoomMessageStore(),
        publish: () => undefined,
      },
      {
        tenantId: TENANT.id,
        principalId: "prn_alice",
        workbenchId: "chan_1",
        definitionId: "wfd_echo",
        args: "summarize this thread",
      },
    );

    expect(result).toEqual({
      handle: "echo",
      address: "ins_invited1@acme.example",
    });
    const opening = platform.sentMail.find(
      (mail) => mail.workbenchId === "ins_invited1",
    );
    expect(opening?.content.content).toBe("summarize this thread");
    expect(opening?.fromWorkbenchId).toBe("chan_1");
  });

  test("empty args still start the run, with a 'Continue.' opening mail", async () => {
    const store = createInMemoryChatStore();
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "Echo" }],
    });
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_2",
      settings: { "chat/kind": "workbench", "chat/participants": [] },
      updatedBy: "prn_alice",
    });

    await startWorkflowCommand(
      {
        store,
        platform,
        roomMessages: createInMemoryRoomMessageStore(),
        publish: () => undefined,
      },
      {
        tenantId: TENANT.id,
        principalId: "prn_alice",
        workbenchId: "chan_2",
        definitionId: "wfd_echo",
        args: "   ",
      },
    );

    const opening = platform.sentMail.find(
      (mail) => mail.workbenchId === "ins_invited1",
    );
    expect(opening?.content.content).toBe("Continue.");
  });

  test("throws loud for a workbench that does not exist", async () => {
    const store = createInMemoryChatStore();
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "Echo" }],
    });

    await expect(
      startWorkflowCommand(
        {
          store,
          platform,
          roomMessages: createInMemoryRoomMessageStore(),
          publish: () => undefined,
        },
        {
          tenantId: TENANT.id,
          principalId: "prn_alice",
          workbenchId: "chan_missing",
          definitionId: "wfd_echo",
          args: "hi",
        },
      ),
    ).rejects.toThrow(/No workbench "chan_missing"/);
  });
});
