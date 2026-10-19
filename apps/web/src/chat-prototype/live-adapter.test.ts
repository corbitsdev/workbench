import { describe, expect, test } from "bun:test";

import type { WorkbenchMessage, WorkbenchParticipant } from "@/chat/threads-api";
import { appendRoster } from "@/chat/workbench-roster";

import { LIVE_ME_ID, liveConversation, unsettledSends } from "./live-adapter";
import type { ChatMessage, TimelineEntry } from "./model";

const ADA: WorkbenchParticipant = {
  id: "agent-ada",
  kind: "agent",
  name: "Ada",
  address: "run_ada@bench.test",
};
const SAM: WorkbenchParticipant = {
  id: "person-sam",
  kind: "person",
  name: "Sam Chen",
  address: "sam@bench.test",
};

function mail(
  overrides: Partial<WorkbenchMessage> & Pick<WorkbenchMessage, "id">,
): WorkbenchMessage {
  return {
    messageId: `<${overrides.id}@bench.test>`,
    author: "other",
    authorName: "run_ada",
    body: "Hello",
    at: "2026-10-19T10:00:00.000Z",
    address: ADA.address,
    parentMessageId: undefined,
    attachments: [],
    ...overrides,
  };
}

function messages(entries: readonly TimelineEntry[]): ChatMessage[] {
  return entries.filter((entry): entry is ChatMessage => entry.type === "message");
}

describe("liveConversation", () => {
  test("own sends belong to you and lose the roster block agents need", () => {
    const body = appendRoster("Check the renewals", [
      { name: "Ada", address: ADA.address, kind: "agent" },
    ]);
    const { entries } = liveConversation(
      [mail({ id: "Sent:1", author: "me", authorName: "You", body, address: "me@bench.test" })],
      [ADA],
    );
    const [own] = messages(entries);
    expect(own?.authorId).toBe(LIVE_ME_ID);
    expect(own?.parts).toEqual([{ type: "text", text: "Check the renewals" }]);
  });

  test("an agent's reply is attributed by address and drops its trailing name line", () => {
    const { entries } = liveConversation(
      [mail({ id: "INBOX:1", body: "On it.\nName: Ada" })],
      [ADA, SAM],
    );
    const [reply] = messages(entries);
    expect(reply?.authorId).toBe(ADA.id);
    expect(reply?.parts).toEqual([{ type: "text", text: "On it." }]);
  });

  test("a restarted run's address still resolves to the bench's only agent", () => {
    const { entries } = liveConversation(
      [mail({ id: "INBOX:1", address: "run_new@bench.test" })],
      [ADA, SAM],
    );
    expect(messages(entries)[0]?.authorId).toBe(ADA.id);
  });

  test("a sender outside the roster becomes a participant named by their address", () => {
    const { entries, participants } = liveConversation(
      [mail({ id: "INBOX:1", address: "lee@elsewhere.test", authorName: "lee" })],
      [ADA, { ...ADA, id: "agent-linus", name: "Linus", address: "run_linus@bench.test" }],
    );
    const authorId = messages(entries)[0]?.authorId;
    expect(authorId).toBe("address:lee@elsewhere.test");
    expect(participants.find((participant) => participant.id === authorId)).toEqual({
      id: "address:lee@elsewhere.test",
      kind: "person",
      name: "lee",
    });
  });

  test("attachments lead the message as files, text ones with an excerpt", () => {
    const { entries } = liveConversation(
      [
        mail({
          id: "INBOX:1",
          body: "Report attached",
          attachments: [{ name: "report.md", contentType: "text/markdown", text: "# Weekly" }],
        }),
      ],
      [ADA],
    );
    expect(messages(entries)[0]?.parts).toEqual([
      {
        type: "file",
        name: "report.md",
        mediaType: "text/markdown",
        size: "8 B",
        excerpt: "# Weekly",
      },
      { type: "text", text: "Report attached" },
    ]);
  });

  test("a reply joins its parent's replies and the parent counts it", () => {
    const parent = mail({ id: "INBOX:1", at: "2026-10-19T10:00:00.000Z" });
    const reply = mail({
      id: "Sent:2",
      author: "me",
      authorName: "You",
      address: "me@bench.test",
      body: "Can you add tests?",
      at: "2026-10-19T10:05:00.000Z",
      parentMessageId: parent.messageId,
    });
    const [main, child] = messages(liveConversation([parent, reply], [ADA]).entries);
    expect(child?.threadId).toBe(main?.id);
    expect(main?.thread).toEqual({ count: 1, lastAt: reply.at });
  });
});

describe("unsettledSends", () => {
  const sent = {
    id: "pending-1",
    text: "Check the renewals",
    at: "2026-10-19T10:00:00.000Z",
  };

  test("a send stays pending until the mailbox echoes it back", () => {
    expect(unsettledSends([], [sent])).toEqual([sent]);
  });

  test("an echoed send with the same text is settled", () => {
    const { entries } = liveConversation(
      [
        mail({
          id: "Sent:1",
          author: "me",
          authorName: "You",
          address: "me@bench.test",
          body: sent.text,
          at: "2026-10-19T10:00:02.000Z",
        }),
      ],
      [ADA],
    );
    expect(unsettledSends(entries, [sent])).toEqual([]);
  });

  test("an older message with the same text does not settle a new send", () => {
    const { entries } = liveConversation(
      [
        mail({
          id: "Sent:1",
          author: "me",
          authorName: "You",
          address: "me@bench.test",
          body: sent.text,
          at: "2026-10-18T09:00:00.000Z",
        }),
      ],
      [ADA],
    );
    expect(unsettledSends(entries, [sent])).toEqual([sent]);
  });
});
