import { describe, expect, test } from "bun:test";

import {
  createInMemoryRoomMessageStore,
  postRoomMessage,
  previewOf,
} from "./room-messages";

const TENANT = "tnt_1";
const WORKBENCH = "run_room";

function recordingPublisher() {
  const published: { workbenchId: string; type: string; data: unknown }[] = [];
  return {
    published,
    publish: (workbenchId: string, event: { type: string; data: unknown }) => {
      published.push({ workbenchId, type: event.type, data: event.data });
    },
  };
}

describe("postRoomMessage", () => {
  test("persists the message and publishes it onto the workbench's stream", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();

    const posted = await postRoomMessage(
      { roomMessages, publish: publisher.publish },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        sender: { name: null, address: "prn_ada@acme.example" },
        senderPrincipalId: "prn_ada",
        parts: [{ kind: "text", text: "morning" }],
      },
    );

    const listed = await roomMessages.listMessages({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
    });
    expect(listed.items.map((message) => message.id)).toEqual([posted.id]);
    // The full rendered row — sender and parts included — so a
    // subscriber can render this message with no follow-up GET.
    expect(publisher.published).toEqual([
      {
        workbenchId: WORKBENCH,
        type: "chat.message",
        data: {
          id: posted.id,
          workbenchId: WORKBENCH,
          createdAt: posted.createdAt,
          threadId: null,
          sender: { name: null, address: "prn_ada@acme.example" },
          parts: [{ kind: "text", text: "morning" }],
        },
      },
    ]);
  });

  test("an agent's message carries its run, a human's carries its principal", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    const post = (input: Parameters<typeof postRoomMessage>[1]) =>
      postRoomMessage({ roomMessages, publish: publisher.publish }, input);

    const human = await post({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      sender: { name: null, address: "prn_ada@acme.example" },
      senderPrincipalId: "prn_ada",
      parts: [{ kind: "text", text: "who's there?" }],
    });
    const agent = await post({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      sender: { name: null, address: "run_myra@acme.example" },
      runId: "run_myra",
      parts: [{ kind: "text", text: "me" }],
    });

    expect(human.senderPrincipalId).toBe("prn_ada");
    expect(human.runId).toBeNull();
    expect(agent.runId).toBe("run_myra");
    expect(agent.senderPrincipalId).toBeNull();
  });

  test("one workbench's timeline never leaks into another's", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    await postRoomMessage(
      { roomMessages, publish: publisher.publish },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        sender: { name: null, address: "prn_ada@acme.example" },
        parts: [{ kind: "text", text: "ours" }],
      },
    );

    const other = await roomMessages.listMessages({
      tenantId: TENANT,
      workbenchId: "run_elsewhere",
    });
    expect(other.items).toEqual([]);
  });
});

describe("listMessages", () => {
  test("reads newest first and pages back through the cursor", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    const ids: string[] = [];
    for (let index = 0; index < 55; index += 1) {
      const posted = await postRoomMessage(
        { roomMessages, publish: publisher.publish },
        {
          tenantId: TENANT,
          workbenchId: WORKBENCH,
          sender: { name: null, address: "prn_ada@acme.example" },
          parts: [{ kind: "text", text: `message ${index}` }],
        },
      );
      ids.push(posted.id);
    }

    const page1 = await roomMessages.listMessages({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
    });
    expect(page1.items).toHaveLength(50);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await roomMessages.listMessages({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      cursor: page1.nextCursor as string,
    });
    expect(page2.items).toHaveLength(5);
    expect(page2.nextCursor).toBeUndefined();
    // Every message appears exactly once across the two pages: a cursor
    // never skips a message and never repeats one.
    const paged = [...page1.items, ...page2.items].map((message) => message.id);
    expect(new Set(paged)).toEqual(new Set(ids));
  });
});

describe("listActivity", () => {
  test("reports the newest message, the unread count, and a preview", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    const post = (text: string) =>
      postRoomMessage(
        { roomMessages, publish: publisher.publish },
        {
          tenantId: TENANT,
          workbenchId: WORKBENCH,
          sender: { name: null, address: "prn_ada@acme.example" },
          parts: [{ kind: "text", text }],
        },
      );

    const first = await post("first");
    await Bun.sleep(2);
    const second = await post("second");

    const activity = await roomMessages.listActivity({
      tenantId: TENANT,
      workbenches: [
        { workbenchId: WORKBENCH, sinceCreatedAt: first.createdAt },
        { workbenchId: "run_never_opened" },
      ],
    });

    expect(activity[WORKBENCH]).toEqual({
      unreadCount: 1,
      lastActivityAt: second.createdAt,
      preview: "second",
    });
    // A workbench with no messages is absent, never a fabricated zero.
    expect(activity["run_never_opened"]).toBeUndefined();
  });
});

describe("previewOf", () => {
  test("collapses whitespace and truncates long text", () => {
    expect(previewOf([{ kind: "text", text: " hello   there \n" }])).toBe(
      "hello there",
    );
    expect(previewOf([{ kind: "text", text: "x".repeat(120) }])).toEndWith("…");
  });

  test("an attachment-only message previews as nothing", () => {
    expect(
      previewOf([
        {
          kind: "file",
          name: "notes.pdf",
          mediaType: "application/pdf",
          blobId: "blb_1",
        },
      ]),
    ).toBe("");
  });
});
