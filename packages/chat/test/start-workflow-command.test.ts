// `startWorkflowCommand` is the `WorkflowCommandDeps.startWorkflow`
// implementation `@corbits/chat` hands `@corbits/commands`' built-in
// workflow-command registrar: invite-then-send, sharing the same
// `launchAndJoinAgent` core as `POST .../invite`.
import { describe, expect, test } from "bun:test";
import { startWorkflowCommand } from "../src/channel-service";
import { createInMemoryChatStore } from "../src/store";
import { fakePlatform, TENANT } from "./test-support";

describe("startWorkflowCommand", () => {
  test("invites the definition and sends the args as the new agent's opening mail", async () => {
    const store = createInMemoryChatStore();
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "Echo" }],
    });
    await store.createChannelSettings({
      tenantId: TENANT.id,
      channelId: "chan_1",
      settings: { "chat/kind": "channel", "chat/participants": [] },
      updatedBy: "prn_alice",
    });

    const result = await startWorkflowCommand(
      { store, platform, publish: () => undefined },
      {
        tenantId: TENANT.id,
        principalId: "prn_alice",
        channelId: "chan_1",
        definitionId: "wfd_echo",
        args: "summarize this thread",
      },
    );

    expect(result).toEqual({
      handle: "echo",
      address: "ins_invited1@acme.example",
    });
    const opening = platform.sentMail.find(
      (mail) => mail.channelId === "ins_invited1",
    );
    expect(opening?.content.content).toBe("summarize this thread");
    expect(opening?.fromChannelId).toBe("chan_1");
  });

  test("empty args still start the run, with a 'Continue.' opening mail", async () => {
    const store = createInMemoryChatStore();
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "Echo" }],
    });
    await store.createChannelSettings({
      tenantId: TENANT.id,
      channelId: "chan_2",
      settings: { "chat/kind": "channel", "chat/participants": [] },
      updatedBy: "prn_alice",
    });

    await startWorkflowCommand(
      { store, platform, publish: () => undefined },
      {
        tenantId: TENANT.id,
        principalId: "prn_alice",
        channelId: "chan_2",
        definitionId: "wfd_echo",
        args: "   ",
      },
    );

    const opening = platform.sentMail.find(
      (mail) => mail.channelId === "ins_invited1",
    );
    expect(opening?.content.content).toBe("Continue.");
  });

  test("throws loud for a channel that does not exist", async () => {
    const store = createInMemoryChatStore();
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "Echo" }],
    });

    await expect(
      startWorkflowCommand(
        { store, platform, publish: () => undefined },
        {
          tenantId: TENANT.id,
          principalId: "prn_alice",
          channelId: "chan_missing",
          definitionId: "wfd_echo",
          args: "hi",
        },
      ),
    ).rejects.toThrow(/No channel "chan_missing"/);
  });
});
