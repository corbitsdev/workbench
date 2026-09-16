// CL-7448: a `chat.message` SSE event carries the workbench ref and the
// row's mail threading headers — Message-ID, In-Reply-To, References — so
// a subscriber can correlate the timeline row with the mail thread it was
// sent as, with no follow-up read. The ref rides every event; the headers
// ride only a stamped row (a human send through the mailbox fan-out), never
// invented for a row nobody mailed.
import { describe, expect, test } from "bun:test";

import { sendWorkbenchMessage } from "../src/workbench-service";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { postRoomMessage } from "../src/room-messages";
import { ChatMessageEventData } from "../src/stream-events";
import { createInMemoryChatStore } from "../src/store";
import { createInMemoryMessagePartsStore } from "../src/message-parts";
import { createInMemoryTurnClaimStore } from "../src/turn-claims";
import { createWorkbenchTurnQueue } from "../src/turn-queue";
import { createTurnCancelRegistry } from "../src/turn-cancellation";
import { replyThreadId } from "../src/threads-native";
import type { MailboxWriter } from "../src/mailbox-fanout";
import type { ParticipantRecord } from "../src/participants";

const TENANT_ID = "tnt_1";
const WORKBENCH_ID = "wb_1";
const DOMAIN = "acme.example";
const SENDER = "prn_alice";
const OTHER_HUMANS = ["prn_bob", "prn_carol"];
const AGENT_ADDRESS = "ins_echo1@acme.example";

function participantsOf(
  senderId: string,
  humanIds: readonly string[],
  agentAddress: string,
): ParticipantRecord[] {
  return [
    { address: senderId, handle: senderId },
    ...humanIds.map((id) => ({ address: id, handle: id })),
    { address: agentAddress, handle: "echo" },
  ];
}

function harness() {
  const store = createInMemoryChatStore();
  const roomMessages = createInMemoryRoomMessageStore();
  const claims = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
  const turnQueue = createWorkbenchTurnQueue({
    claims,
    publish: () => undefined,
  });
  const events: { type: string; data: unknown }[] = [];
  const writer: MailboxWriter = {
    async writeBatch(items) {
      return items.map((item) => ({
        messageKey: item.messageId,
        id: item.messageId,
      }));
    },
  };
  const known = new Set([SENDER, ...OTHER_HUMANS]);
  const deps = {
    store,
    roomMessages,
    publish: (_workbenchId: string, event: { type: string; data: unknown }) => {
      events.push(event);
    },
    platform: {
      async sendMail() {
        return { id: "mail_agent_1", createdAt: new Date().toISOString() };
      },
    },
    turnQueue,
    turnCancellation: createTurnCancelRegistry(),
    parts: createInMemoryMessagePartsStore(),
    mailbox: {
      writer,
      resolveKnownPrincipalIds: async (
        _tenantId: string,
        candidateIds: readonly string[],
      ) => new Set(candidateIds.filter((id) => known.has(id))),
      resolveTenantDomain: async (_tenantId: string) => DOMAIN,
    },
  };
  return { deps, store, roomMessages, events };
}

async function messageEventOf(
  h: ReturnType<typeof harness>,
  id: string,
): Promise<unknown> {
  const event = h.events.find(
    (candidate) =>
      candidate.type === "chat.message" &&
      (candidate.data as { id?: string }).id === id,
  );
  expect(event).toBeDefined();
  return event?.data;
}

describe("chat.message SSE event mail headers (CL-7448)", () => {
  test("a root-feed send publishes the workbench ref and the row's Message-ID, threading under nothing", async () => {
    const h = harness();
    await h.store.createWorkbenchSettings({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      updatedBy: SENDER,
      settings: {
        "chat/participants": participantsOf(
          SENDER,
          OTHER_HUMANS,
          AGENT_ADDRESS,
        ),
      },
    });

    const result = await sendWorkbenchMessage(h.deps, {
      tenantId: TENANT_ID,
      principalId: SENDER,
      senderAddress: `${SENDER}@${DOMAIN}`,
      workbenchId: WORKBENCH_ID,
      messageParts: [{ kind: "text", text: "hello everyone" }],
    });
    await result.fanoutDelivered;

    const parsed = ChatMessageEventData.assert(
      await messageEventOf(h, result.id),
    );
    const headers = parsed as unknown as Record<string, unknown>;
    expect(headers["ref"]).toEqual({ kind: "workbench", id: WORKBENCH_ID });
    expect(headers["messageId"]).toBe(`<${result.id}@${DOMAIN}>`);
    expect(headers["inReplyTo"]).toBeUndefined();
    expect(headers["references"]).toBeUndefined();
  });

  test("a reply send publishes the parent chain as In-Reply-To and References", async () => {
    const h = harness();
    await h.store.createWorkbenchSettings({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      updatedBy: SENDER,
      settings: {
        "chat/participants": participantsOf(
          SENDER,
          OTHER_HUMANS,
          AGENT_ADDRESS,
        ),
      },
    });

    const root = await sendWorkbenchMessage(h.deps, {
      tenantId: TENANT_ID,
      principalId: SENDER,
      senderAddress: `${SENDER}@${DOMAIN}`,
      workbenchId: WORKBENCH_ID,
      messageParts: [{ kind: "text", text: "the original" }],
    });
    await root.fanoutDelivered;

    const reply = await sendWorkbenchMessage(h.deps, {
      tenantId: TENANT_ID,
      principalId: SENDER,
      senderAddress: `${SENDER}@${DOMAIN}`,
      workbenchId: WORKBENCH_ID,
      messageParts: [{ kind: "text", text: "a reply" }],
      threadId: replyThreadId(root.id),
    });
    await reply.fanoutDelivered;

    const parsed = ChatMessageEventData.assert(
      await messageEventOf(h, reply.id),
    );
    const headers = parsed as unknown as Record<string, unknown>;
    expect(headers["ref"]).toEqual({ kind: "workbench", id: WORKBENCH_ID });
    expect(headers["messageId"]).toBe(`<${reply.id}@${DOMAIN}>`);
    expect(headers["inReplyTo"]).toBe(`<${root.id}@${DOMAIN}>`);
    expect(headers["references"]).toEqual([`<${root.id}@${DOMAIN}>`]);
  });

  test("a row nobody mailed still publishes its ref, with no headers invented for it", async () => {
    const h = harness();

    const posted = await postRoomMessage(
      { roomMessages: h.roomMessages, publish: h.deps.publish },
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        sender: { name: null, address: `run_myra@${DOMAIN}` },
        runId: "run_myra",
        parts: [{ kind: "text", text: "me" }],
      },
    );

    const parsed = ChatMessageEventData.assert(
      await messageEventOf(h, posted.id),
    );
    const headers = parsed as unknown as Record<string, unknown>;
    expect(headers["ref"]).toEqual({ kind: "workbench", id: WORKBENCH_ID });
    expect(headers["messageId"]).toBeUndefined();
    expect(headers["inReplyTo"]).toBeUndefined();
    expect(headers["references"]).toBeUndefined();
  });
});
