// Proves the orchestrator's own wiring: a `connector.reply` on the
// shared `agent.event` stream resolves the replying address to its
// folded run, finds every channel whose participants carry that
// address (defensively — more than one, if the store ever shows it),
// and posts the reply into each via `platform.sendMail` with
// `fromChannelId` set to the agent's own run id. Non-reply events are
// ignored for posting but still bump activity; an address the store
// never produced (no folded run) is ignored outright; `dispose` stops
// the subscription.
import { describe, expect, test } from "bun:test";
import { createSidecarEmitter } from "@intx/hub-sessions";
import { createChatOrchestrator } from "../src/chat-orchestrator";
import type { ChannelSettingsRow } from "../src/store";

// The real `findFoldedRunByAddress` (exercised, not mocked, so this
// file never risks poisoning `@corbits/folded-runs`'s module namespace
// for `platform-adapter.test.ts` when the whole package's suite runs
// in one process) calls `db.query.workflowRun.findFirst({ where:
// eq(workflowRun.address, address) })`. Every scenario here configures
// at most one run, so this fake ignores the `where` filter and simply
// returns the configured run regardless of which address was queried
// — the same convention `platform-adapter.test.ts`'s own fake `db`
// uses.
function createFakeDb(run?: { id: string; tenantId: string }) {
  return {
    query: {
      workflowRun: {
        findFirst: async () => run,
      },
    },
  };
}

function channelRow(
  channelId: string,
  participantAddresses: string[],
): ChannelSettingsRow {
  return {
    tenantId: "ten_1",
    channelId,
    settings: {
      "chat/kind": "channel",
      "chat/participants": participantAddresses.map((address) => ({
        address,
        handle: address.split("@")[0],
      })),
    },
    updatedBy: "prn_1",
    updatedAt: new Date(),
  };
}

describe("createChatOrchestrator", () => {
  test("posts a connector.reply into the member channel resolved from the store", async () => {
    const sentMail: {
      tenantId: string;
      channelId: string;
      content: unknown;
      fromChannelId?: string;
    }[] = [];
    const listChannelSettingsCalls: string[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listChannelSettings: async (tenantId) => {
          listChannelSettingsCalls.push(tenantId);
          return [
            channelRow("ins_channel1", ["ins_echo1@ten1.workbench.test"]),
          ];
        },
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push(input as never);
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events,
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hello back" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listChannelSettingsCalls).toEqual(["ten_1"]);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]).toMatchObject({
      tenantId: "ten_1",
      channelId: "ins_channel1",
      fromChannelId: "ins_echo1",
    });

    orchestrator.dispose();
  });

  test("posts into every channel when the store shows the address in more than one", async () => {
    const sentMail: { channelId: string }[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listChannelSettings: async () => [
          channelRow("ins_channel1", ["ins_echo1@ten1.workbench.test"]),
          channelRow("ins_channel2", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push({ channelId: input.channelId });
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events,
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail.map((m) => m.channelId).sort()).toEqual([
      "ins_channel1",
      "ins_channel2",
    ]);

    orchestrator.dispose();
  });

  test("ignores non-reply events for posting but still bumps activity", async () => {
    const sentMail: unknown[] = [];
    const recordActivityCalls: string[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: { listChannelSettings: async () => [] },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
      recordActivity: (address) => recordActivityCalls.push(address),
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.turn.started", data: {} },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(0);
    expect(recordActivityCalls).toEqual(["ins_echo1@ten1.workbench.test"]);

    orchestrator.dispose();
  });

  test("ignores an address with no folded run", async () => {
    const sentMail: unknown[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb(undefined) as never,
      store: { listChannelSettings: async () => [] },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
    });

    events.emit("agent.event", {
      agentAddress: "unknown@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(0);

    orchestrator.dispose();
  });

  test("dispose unsubscribes from the event stream", async () => {
    const sentMail: unknown[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listChannelSettings: async () => [
          channelRow("ins_channel1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
    });

    orchestrator.dispose();

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(0);
  });
});
