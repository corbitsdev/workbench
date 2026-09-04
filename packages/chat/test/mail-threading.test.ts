// Thread turn dispatch by RFC Message-ID (CL-7104). Chat is a mail
// thread: a dispatched timeline row goes out under its own `Message-ID`
// and names its parentage in `In-Reply-To` / `References`, and that is
// the only thing an agent's reply is correlated back through — never the
// sender's address, never a correlation id.
import { describe, expect, test } from "bun:test";

import { dispatchTurn } from "../src/workbench-service";
import type { MailContent } from "../src/codec";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { createInMemoryThreadStore } from "../src/threads";
import { createInMemoryTurnMailCorrelationStore } from "../src/turn-mail-correlation";
import { mailIdFromBracketMessageId } from "../src/turn-mail-correlation";

const TENANT = "ten_1";
const WORKBENCH = "ins_workbench1";
const AGENT = "ins_echo1@acme.example";

function harness() {
  const roomMessages = createInMemoryRoomMessageStore();
  const threads = createInMemoryThreadStore();
  const turnMailCorrelation = createInMemoryTurnMailCorrelationStore();
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
    threads,
    turnMailCorrelation,
    publish: () => undefined,
  };
  return { deps, roomMessages, threads, turnMailCorrelation, sent };
}

async function postRow(
  roomMessages: ReturnType<typeof createInMemoryRoomMessageStore>,
  text: string,
  threadId?: string,
) {
  return roomMessages.insertMessage({
    id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    tenantId: TENANT,
    workbenchId: WORKBENCH,
    sender: { name: "Alice", address: "alice@acme.example" },
    parts: [{ kind: "text", text }],
    ...(threadId !== undefined ? { threadId } : {}),
  });
}

async function dispatch(
  h: ReturnType<typeof harness>,
  requestMessageIds: readonly string[],
) {
  await dispatchTurn(h.deps as never, {
    tenantId: TENANT,
    workbenchId: WORKBENCH,
    principalId: "prn_alice",
    agentAddress: AGENT,
    parts: [{ kind: "text", text: "over to you" }],
    requestMessageIds,
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
    const thread = await h.threads.openReplyThread({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      parentMessageId: anchor.id,
    });
    const inThread = await postRow(h.roomMessages, "a reply", thread.id);
    await h.threads.assignMessage({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      threadId: thread.id,
      messageId: inThread.id,
    });
    const sub = await h.threads.forkThread({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      parentMessageId: inThread.id,
    });
    const inSub = await postRow(h.roomMessages, "@ins_echo1 look", sub.id);
    await h.threads.assignMessage({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      threadId: sub.id,
      messageId: inSub.id,
    });

    await dispatch(h, [inSub.id]);

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
    const firstThread = await h.threads.openReplyThread({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      parentMessageId: first.id,
    });
    const inFirst = await postRow(
      h.roomMessages,
      "@ins_echo1 one",
      firstThread.id,
    );
    await h.threads.assignMessage({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      threadId: firstThread.id,
      messageId: inFirst.id,
    });

    const second = await postRow(h.roomMessages, "question two");
    const secondThread = await h.threads.openReplyThread({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      parentMessageId: second.id,
    });
    const inSecond = await postRow(
      h.roomMessages,
      "@ins_echo1 two",
      secondThread.id,
    );
    await h.threads.assignMessage({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      threadId: secondThread.id,
      messageId: inSecond.id,
    });

    // Both turns are in flight against the same agent address.
    await dispatch(h, [inFirst.id]);
    await dispatch(h, [inSecond.id]);

    expect(h.sent.map((mail) => mail.messageId)).toEqual([
      `<${inFirst.id}@acme.example>`,
      `<${inSecond.id}@acme.example>`,
    ]);

    // A reply arriving inside the SECOND dispatch's bracket resolves to
    // the second turn's source, not the newest-per-address guess: the
    // bracket's Message-ID is what names it.
    const secondBracket = h.sent[1]?.messageId ?? "";
    expect(
      await h.turnMailCorrelation.findTurnMailSource({
        tenantId: TENANT,
        mailId: mailIdFromBracketMessageId(secondBracket),
      }),
    ).toEqual({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      sourceMessageId: inSecond.id,
    });

    // And the first turn's bracket still names the first source — one
    // address, two pending turns, no ambiguity.
    const firstBracket = h.sent[0]?.messageId ?? "";
    expect(
      await h.turnMailCorrelation.findTurnMailSource({
        tenantId: TENANT,
        mailId: mailIdFromBracketMessageId(firstBracket),
      }),
    ).toMatchObject({ sourceMessageId: inFirst.id });
  });

  test("a dispatch answering nothing threads under nothing rather than guessing a parent", async () => {
    const h = harness();

    await dispatch(h, []);

    expect(h.sent[0]?.messageId).toBeUndefined();
    expect(h.sent[0]?.inReplyTo).toBeUndefined();
  });
});
