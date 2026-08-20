import { describe, expect, test } from "bun:test";

import { createInMemoryRoomMessageStore } from "./room-messages";
import { assembleTurnContext } from "./turn-context";

const TENANT = "ten_1";
const WORKBENCH = "wb_1";
const PARTICIPANTS = [
  { address: "ins_echo1@acme.example", handle: "echo" },
] as const;

async function seed(texts: readonly { from: string; text: string }[]) {
  const roomMessages = createInMemoryRoomMessageStore();
  const ids: string[] = [];
  for (const entry of texts) {
    const posted = await roomMessages.insertMessage({
      id: `msg_${String(ids.length).padStart(3, "0")}`,
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      sender: { name: null, address: entry.from },
      parts: [{ kind: "text", text: entry.text }],
    });
    ids.push(posted.id);
  }
  return { roomMessages, ids };
}

describe("assembleTurnContext", () => {
  test("renders the room oldest-first, labelling a known agent by its handle", async () => {
    const { roomMessages, ids } = await seed([
      { from: "prn_alice@acme.example", text: "first" },
      { from: "ins_echo1@acme.example", text: "second" },
      { from: "prn_alice@acme.example", text: "the new one" },
    ]);

    const context = await assembleTurnContext({
      roomMessages,
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      excludeMessageId: ids[2] ?? "",
      participants: PARTICIPANTS,
      contextWindow: 10,
    });

    expect(context).toContain("user: first");
    expect(context).toContain("@echo: second");
    expect(context).not.toContain("the new one");
    expect(context?.indexOf("first")).toBeLessThan(
      context?.indexOf("second") ?? -1,
    );
  });

  test("a context window of zero assembles nothing at all", async () => {
    const { roomMessages } = await seed([
      { from: "prn_alice@acme.example", text: "first" },
    ]);

    expect(
      await assembleTurnContext({
        roomMessages,
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        excludeMessageId: "msg_none",
        participants: PARTICIPANTS,
        contextWindow: 0,
      }),
    ).toBeUndefined();
  });

  test("what the window drops is folded into a recap, never silently lost", async () => {
    const { roomMessages } = await seed(
      Array.from({ length: 6 }, (_, i) => ({
        from: "prn_alice@acme.example",
        text: `message ${String(i)}`,
      })),
    );

    const context = await assembleTurnContext({
      roomMessages,
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      excludeMessageId: "msg_none",
      participants: PARTICIPANTS,
      contextWindow: 2,
    });

    expect(context).toContain("Earlier in this conversation");
    expect(context).toContain("message 5");
    expect(context).toContain("message 4");
  });

  test("a thread-scoped turn sees its own thread, never the whole room", async () => {
    const { roomMessages, ids } = await seed([
      { from: "prn_alice@acme.example", text: "root feed chatter" },
      { from: "prn_alice@acme.example", text: "in the thread" },
      { from: "ins_echo1@acme.example", text: "also in the thread" },
    ]);
    const threadOf = new Map<string, string>([
      [ids[0] ?? "", "thr_root"],
      [ids[1] ?? "", "thr_reply"],
      [ids[2] ?? "", "thr_reply"],
    ]);

    const context = await assembleTurnContext({
      roomMessages,
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      excludeMessageId: "msg_none",
      participants: PARTICIPANTS,
      contextWindow: 10,
      thread: {
        threadId: "thr_reply",
        threadIdOf: (messageId) => threadOf.get(messageId) ?? "thr_root",
      },
    });

    expect(context).toContain("in the thread");
    expect(context).toContain("also in the thread");
    expect(context).not.toContain("root feed chatter");
  });

  test("a timeline that cannot be read never breaks the turn", async () => {
    const context = await assembleTurnContext({
      roomMessages: {
        listMessages: () => Promise.reject(new Error("timeline is down")),
      },
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      excludeMessageId: "msg_none",
      participants: PARTICIPANTS,
      contextWindow: 10,
    });

    expect(context).toBeUndefined();
  });
});
