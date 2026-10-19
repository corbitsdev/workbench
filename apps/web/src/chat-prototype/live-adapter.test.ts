import { describe, expect, test } from "bun:test";

import type { WorkbenchMessage, WorkbenchParticipant } from "@/chat/threads-api";
import { appendRoster } from "@/chat/workbench-roster";

import type { Approval } from "@/api";

import {
  LIVE_ME_ID,
  liveApprovals,
  liveConversation,
  unsettledSends,
  workerActivity,
} from "./live-adapter";
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

describe("workerActivity", () => {
  test("a run that reports busy is working", () => {
    expect(
      workerActivity({ runtimeStatus: "busy", waitingOnReply: false, busySinceSend: true }),
    ).toBe("working");
  });

  test("a run parked on an approval needs you, whatever else is true", () => {
    expect(
      workerActivity({
        runtimeStatus: "waiting_approval",
        waitingOnReply: true,
        busySinceSend: true,
      }),
    ).toBe("needs-you");
  });

  test("just after a send the run may still read idle: keep waiting on the reply", () => {
    expect(
      workerActivity({ runtimeStatus: "idle", waitingOnReply: true, busySinceSend: false }),
    ).toBe("working");
  });

  test("once the run has gone busy and back to idle, the turn is over even without a reply", () => {
    expect(
      workerActivity({ runtimeStatus: "idle", waitingOnReply: true, busySinceSend: true }),
    ).toBe("idle");
  });

  test("with no status from the hub, waiting on a reply is the only signal", () => {
    expect(
      workerActivity({ runtimeStatus: undefined, waitingOnReply: true, busySinceSend: false }),
    ).toBe("working");
    expect(
      workerActivity({ runtimeStatus: undefined, waitingOnReply: false, busySinceSend: false }),
    ).toBe("idle");
  });
});

describe("liveApprovals", () => {
  function approval(overrides: Partial<Approval> & Pick<Approval, "id">): Approval {
    return {
      tenantId: "bench",
      anchorRunId: "run_ada",
      runId: "run_ada",
      agentAddress: ADA.address,
      correlationId: "corr-1",
      toolDefinition: {
        name: "read_file",
        description: "Read a file and return its content with line numbers. The path may be a URL.",
      },
      toolArguments: { path: "notes/q4.md", limit: 80 },
      scope: null,
      status: "pending",
      timeoutAt: null,
      resolvedAt: null,
      createdAt: "2026-10-19T12:00:06.000Z",
      updatedAt: "2026-10-19T12:00:06.000Z",
      ...overrides,
    };
  }

  test("a pending approval is a card from the agent that asked, when it asked", () => {
    const [card] = liveApprovals([approval({ id: "apr_1" })], [ADA, SAM]);
    expect(card?.authorId).toBe(ADA.id);
    expect(card?.at).toBe("2026-10-19T12:00:06.000Z");
    expect(card?.parts).toEqual([
      {
        type: "approval",
        id: "apr_1",
        tool: "read_file",
        summary: "Read a file and return its content with line numbers.",
        scope: "path: notes/q4.md, limit: 80",
        decision: null,
      },
    ]);
  });

  test("approvals already decided don't show", () => {
    expect(liveApprovals([approval({ id: "apr_1", status: "approved" })], [ADA])).toEqual([]);
  });
});
