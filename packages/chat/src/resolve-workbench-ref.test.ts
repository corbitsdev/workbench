// CL-7449: `resolveWorkbenchIdForAgentFrame` is header-first -- an agent
// that participates in several workbenches at once has no single "the"
// workbench a bare participant scan can name honestly, so a reply's own
// `In-Reply-To` / `References` (mapped back to the timeline row they name,
// via `RoomMessageStore.findByMailMessageId`) is authoritative whenever
// it resolves. The participant scan is a fallback for a header-less frame,
// and only trusted when it names exactly one workbench -- zero or several
// matches must stamp nothing and report once, never guess.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const reportErrorCalls: {
  error: unknown;
  context: Record<string, unknown>;
}[] = [];

mock.module("@corbits/error-sink", () => ({
  reportError: (error: unknown, context: Record<string, unknown>) => {
    reportErrorCalls.push({ error, context });
    return "ref_test";
  },
  generateRefId: () => "ref_test",
}));

const { resolveWorkbenchIdForAgentFrame } = await import("./mail-headers");
const { createInMemoryChatStore } = await import("./store");
const { createInMemoryRoomMessageStore } = await import("./room-messages");

const TENANT = "tnt_1";
const DOMAIN = "d.test";

beforeEach(() => {
  reportErrorCalls.length = 0;
});
afterAll(() => {
  mock.restore();
});

async function seedWorkbench(
  chatStore: ReturnType<typeof createInMemoryChatStore>,
  workbenchId: string,
  participantAddress: string,
) {
  await chatStore.createWorkbenchSettings({
    tenantId: TENANT,
    workbenchId,
    settings: {
      "chat/participants": [{ address: participantAddress, handle: "sender" }],
    },
    updatedBy: "usr_updater",
  });
}

describe("resolveWorkbenchIdForAgentFrame", () => {
  test("header resolves to the parent row's workbench even when the agent participates in two workbenches", async () => {
    const chatStore = createInMemoryChatStore();
    const roomMessages = createInMemoryRoomMessageStore();
    const senderAddress = `ins_agent1@${DOMAIN}`;

    await seedWorkbench(chatStore, "wb_one", senderAddress);
    await seedWorkbench(chatStore, "wb_two", senderAddress);

    const parentRow = await roomMessages.insertMessage({
      id: "msg_parent",
      tenantId: TENANT,
      workbenchId: "wb_two",
      sender: { address: "usr_human@d.test", name: "Human" },
      parts: [{ kind: "text", text: "hi" }],
    });
    const mailMessageId = `<${parentRow.id}@${DOMAIN}>`;
    await roomMessages.stampMailMessageId({
      tenantId: TENANT,
      workbenchId: "wb_two",
      messageId: parentRow.id,
      mailMessageId,
    });

    const workbenchId = await resolveWorkbenchIdForAgentFrame(
      { chatStore, roomMessages },
      TENANT,
      { senderAddress, inReplyTo: mailMessageId },
    );

    expect(workbenchId).toBe("wb_two");
    expect(reportErrorCalls).toHaveLength(0);
  });

  test("no header and a single participation resolves to that workbench", async () => {
    const chatStore = createInMemoryChatStore();
    const roomMessages = createInMemoryRoomMessageStore();
    const senderAddress = `ins_agent2@${DOMAIN}`;

    await seedWorkbench(chatStore, "wb_only", senderAddress);

    const workbenchId = await resolveWorkbenchIdForAgentFrame(
      { chatStore, roomMessages },
      TENANT,
      { senderAddress },
    );

    expect(workbenchId).toBe("wb_only");
    expect(reportErrorCalls).toHaveLength(0);
  });

  test("no header and two participations stamps nothing and reports once", async () => {
    const chatStore = createInMemoryChatStore();
    const roomMessages = createInMemoryRoomMessageStore();
    const senderAddress = `ins_agent3@${DOMAIN}`;

    await seedWorkbench(chatStore, "wb_a", senderAddress);
    await seedWorkbench(chatStore, "wb_b", senderAddress);

    const workbenchId = await resolveWorkbenchIdForAgentFrame(
      { chatStore, roomMessages },
      TENANT,
      { senderAddress },
    );

    expect(workbenchId).toBeUndefined();
    expect(reportErrorCalls).toHaveLength(1);
    expect(reportErrorCalls[0]?.context["operation"]).toBe(
      "mailbox_ref_unresolved",
    );
    expect(reportErrorCalls[0]?.context["tenantId"]).toBe(TENANT);
  });

  test("no header and zero participations stamps nothing and reports once", async () => {
    const chatStore = createInMemoryChatStore();
    const roomMessages = createInMemoryRoomMessageStore();
    const senderAddress = `ins_agent4@${DOMAIN}`;

    const workbenchId = await resolveWorkbenchIdForAgentFrame(
      { chatStore, roomMessages },
      TENANT,
      { senderAddress },
    );

    expect(workbenchId).toBeUndefined();
    expect(reportErrorCalls).toHaveLength(1);
    expect(reportErrorCalls[0]?.context["operation"]).toBe(
      "mailbox_ref_unresolved",
    );
  });
});
