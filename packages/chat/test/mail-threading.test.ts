// Thread turn dispatch by RFC Message-ID (CL-7104). Chat is a mail
// thread: a dispatched timeline row goes out under its own `Message-ID`
// and names its parentage in `In-Reply-To` / `References`, and that is
// the only thing an agent's reply is correlated back through — never the
// sender's address, never a correlation id.
import { describe, expect, test } from "bun:test";

import { dispatchTurn } from "../src/workbench-service";
import type { MailContent } from "../src/codec";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { replyThreadId, subThreadId } from "../src/threads-native";

const TENANT = "ten_1";
const WORKBENCH = "ins_workbench1";
const AGENT = "ins_echo1@acme.example";
const DOMAIN = "acme.example";

function harness() {
  const roomMessages = createInMemoryRoomMessageStore();
  const sent: MailContent[] = [];
  const deps = {
    platform: {
      async sendMail(input: { content: MailContent }) {
        sent.push(input.content);
        return {
          id: `mail_${sent.length}`,
          createdAt: new Date().toISOString(),
        };
      },
    },
    roomMessages,
    publish: () => undefined,
    mailbox: {
      writer: {
        async writeBatch(items: readonly { messageId: string }[]) {
          return items.map((item) => ({
            messageKey: item.messageId,
            id: item.messageId,
          }));
        },
      },
      resolveKnownPrincipalIds: async (
        _tenantId: string,
        candidateIds: readonly string[],
      ) => new Set(candidateIds),
      resolveTenantDomain: async () => DOMAIN,
    },
  };
  return { deps, roomMessages, sent };
}

async function postRow(
  roomMessages: ReturnType<typeof createInMemoryRoomMessageStore>,
  text: string,
  threadId?: string,
) {
  const row = await roomMessages.insertMessage({
    id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    tenantId: TENANT,
    workbenchId: WORKBENCH,
    sender: { name: "Alice", address: "alice@acme.example" },
    parts: [{ kind: "text", text }],
    ...(threadId !== undefined ? { threadId } : {}),
  });
  await roomMessages.stampMailMessageId({
    tenantId: TENANT,
    workbenchId: WORKBENCH,
    messageId: row.id,
    mailMessageId: `<${row.id}@${DOMAIN}>`,
  });
  return row;
}

async function dispatch(
  h: ReturnType<typeof harness>,
  requestMessageIds: readonly string[],
  threadId?: string,
) {
  await dispatchTurn(h.deps as never, {
    tenantId: TENANT,
    workbenchId: WORKBENCH,
    principalId: "prn_alice",
    agentAddress: AGENT,
    parts: [{ kind: "text", text: "over to you" }],
    requestMessageIds,
    ...(threadId !== undefined ? { threadId } : {}),
  });
}

describe("dispatch mail threading", () => {
  test("a root-feed dispatch carries the row's own Message-ID and threads under nothing", async () => {
    const h = harness();
    const row = await postRow(h.roomMessages, "hello");

    await dispatch(h, [row.id]);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.messageId).toBe(`<${row.id}@acme.example>`);
    expect(h.sent[0]?.inReplyTo).toBeUndefined();
    expect(h.sent[0]?.references).toBeUndefined();

    // Stamped on the row, so the header a reply names resolves back to
    // exactly one message.
    const stored = await h.roomMessages.getMessage({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      messageId: row.id,
    });
    expect(stored?.mailMessageId).toBe(`<${row.id}@acme.example>`);
    expect(
      (
        await h.roomMessages.findByMailMessageId({
          tenantId: TENANT,
          mailMessageId: `<${row.id}@acme.example>`,
        })
      )?.id,
    ).toBe(row.id);
  });

  test("a dispatch from inside a sub-thread carries the full References chain, oldest first", async () => {
    const h = harness();
    const anchor = await postRow(h.roomMessages, "the original");
    const replyTid = replyThreadId(anchor.id);
    const inThread = await postRow(h.roomMessages, "a reply", replyTid);
    const subTid = subThreadId(replyTid, inThread.id);
    const inSub = await postRow(h.roomMessages, "@ins_echo1 look", subTid);

    await dispatch(h, [inSub.id], subTid);

    expect(h.sent[0]?.messageId).toBe(`<${inSub.id}@acme.example>`);
    expect(h.sent[0]?.references).toEqual([
      `<${anchor.id}@acme.example>`,
      `<${inThread.id}@acme.example>`,
    ]);
    // In-Reply-To is the chain's tail, per RFC 5322.
    expect(h.sent[0]?.inReplyTo).toBe(`<${inThread.id}@acme.example>`);
  });

  test("two turns pending for one address stay told apart by their Message-IDs, not by the address", async () => {
    const h = harness();
    const first = await postRow(h.roomMessages, "question one");
    const firstTid = replyThreadId(first.id);
    const inFirst = await postRow(
      h.roomMessages,
      "@ins_echo1 one",
      firstTid,
    );

    const second = await postRow(h.roomMessages, "question two");
    const secondTid = replyThreadId(second.id);
    const inSecond = await postRow(
      h.roomMessages,
      "@ins_echo1 two",
      secondTid,
    );

    // Both turns are in flight against the same agent address.
    await dispatch(h, [inFirst.id], firstTid);
    await dispatch(h, [inSecond.id], secondTid);

    expect(h.sent.map((mail) => mail.messageId)).toEqual([
      `<${inFirst.id}@acme.example>`,
      `<${inSecond.id}@acme.example>`,
    ]);

    // Each dispatch's bracket names its own source thread, not the
    // newest-per-address guess: the thread descriptor is what tells them
    // apart.
    expect(h.sent[0]?.inReplyTo).toBe(`<${first.id}@acme.example>`);
    expect(h.sent[1]?.inReplyTo).toBe(`<${second.id}@acme.example>`);
  });

  test("a dispatch answering nothing threads under nothing rather than guessing a parent", async () => {
    const h = harness();

    await dispatch(h, []);

    expect(h.sent[0]?.messageId).toBeUndefined();
    expect(h.sent[0]?.inReplyTo).toBeUndefined();
  });
});
