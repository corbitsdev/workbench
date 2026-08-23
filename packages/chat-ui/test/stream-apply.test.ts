// CL-6328: every stream event applies straight into the query cache it
// describes, never a refetch. These are the pure cache-mutation rules
// `chat-workspace.tsx`'s stream handler calls into — exercised here against
// a real `QueryClient` (no DOM needed) so the dedupe/merge logic is proven
// independent of React.

import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  applyStreamMessage,
  applyStreamPin,
  applyStreamReaction,
  chatMessagesQueryKey,
  chatPinsQueryKey,
  chatThreadsQueryKey,
} from "../src/use-workbench-feed";
import type {
  MessageItem,
  MessagesResponse,
  PinnedMessage,
  Workbench,
} from "../src/api";
import { workbenchesQueryKey } from "../src/api";

const TENANT = "tnt_1";
const WORKBENCH = "wb_1";

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
}

const baseMessage: MessageItem = {
  id: "m1",
  createdAt: "2026-01-01T00:00:00.000Z",
  parts: [{ kind: "text", text: "hello" }],
  sender: { name: "Alice", address: "prn_alice@acme.example" },
};

function seedList(
  qc: QueryClient,
  kind: "workbench" | "chat",
  row: Workbench,
): void {
  qc.setQueryData(workbenchesQueryKey(TENANT, kind), [row] as Workbench[]);
}

describe("applyStreamMessage", () => {
  test("appends a freshly published row into the messages cache", () => {
    const qc = client();
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [],
    } satisfies MessagesResponse);

    applyStreamMessage(qc, TENANT, WORKBENCH, baseMessage);

    const data = qc.getQueryData<MessagesResponse>(
      chatMessagesQueryKey(TENANT, WORKBENCH),
    );
    expect(data?.items).toEqual([baseMessage]);
  });

  test("does nothing to an unloaded cache — never seeds a query nobody asked for", () => {
    const qc = client();
    applyStreamMessage(qc, TENANT, WORKBENCH, baseMessage);
    expect(
      qc.getQueryData(chatMessagesQueryKey(TENANT, WORKBENCH)),
    ).toBeUndefined();
  });

  test("dedupes by id: the workbench's own echo of a message already in cache is a no-op", () => {
    const qc = client();
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [baseMessage],
    } satisfies MessagesResponse);

    applyStreamMessage(qc, TENANT, WORKBENCH, baseMessage);

    const data = qc.getQueryData<MessagesResponse>(
      chatMessagesQueryKey(TENANT, WORKBENCH),
    );
    expect(data?.items).toHaveLength(1);
  });

  test("dedupes by clientId: the stream's echo of this reader's own optimistic send never doubles it (CL-6251 precedent)", () => {
    const qc = client();
    const confirmedByOptimisticWrite: MessageItem = {
      ...baseMessage,
      id: "m_server",
      clientId: "pending_1",
    };
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [confirmedByOptimisticWrite],
    } satisfies MessagesResponse);

    // The same row, as it arrives over the stream — same clientId, same id.
    applyStreamMessage(qc, TENANT, WORKBENCH, confirmedByOptimisticWrite);

    const data = qc.getQueryData<MessagesResponse>(
      chatMessagesQueryKey(TENANT, WORKBENCH),
    );
    expect(data?.items).toHaveLength(1);
  });

  test("bumps the owning thread's replyCount and lastActivityAt", () => {
    const qc = client();
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [],
    } satisfies MessagesResponse);
    qc.setQueryData(chatThreadsQueryKey(TENANT, WORKBENCH), {
      rootThreadId: "root",
      items: [
        {
          id: "thr_1",
          kind: "reply" as const,
          runRef: null,
          title: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          replyCount: 2,
          lastActivityAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    applyStreamMessage(qc, TENANT, WORKBENCH, {
      ...baseMessage,
      id: "m2",
      threadId: "thr_1",
      createdAt: "2026-01-01T00:05:00.000Z",
    });

    const threads = qc.getQueryData<{
      readonly items: readonly {
        replyCount: number;
        lastActivityAt: string | null;
      }[];
    }>(chatThreadsQueryKey(TENANT, WORKBENCH));
    expect(threads?.items[0]?.replyCount).toBe(3);
    expect(threads?.items[0]?.lastActivityAt).toBe("2026-01-01T00:05:00.000Z");
  });

  test("a root-feed message (no threadId) never touches the threads cache", () => {
    const qc = client();
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [],
    } satisfies MessagesResponse);
    const threadsBefore = { rootThreadId: "root", items: [] };
    qc.setQueryData(chatThreadsQueryKey(TENANT, WORKBENCH), threadsBefore);

    applyStreamMessage(qc, TENANT, WORKBENCH, baseMessage);

    expect(
      qc.getQueryData<typeof threadsBefore>(
        chatThreadsQueryKey(TENANT, WORKBENCH),
      ),
    ).toBe(threadsBefore);
  });

  // CL-6795: sidebar list cache must settle on stream apply — never keep a
  // stale greeting after a newer user message, and never blank on join/event.
  test("a newer user message settles the workbench-list preview over a stale greeting (CL-6795)", () => {
    const qc = client();
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [],
    } satisfies MessagesResponse);
    seedList(qc, "chat", {
      id: WORKBENCH,
      title: "Myra",
      kind: "chat",
      pinned: false,
      participants: [],
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      preview: "Hi — I'm Myra. What are we working on?",
    });

    applyStreamMessage(qc, TENANT, WORKBENCH, {
      id: "m_user",
      createdAt: "2026-01-01T00:01:00.000Z",
      parts: [{ kind: "text", text: "draft the agenda for Monday" }],
      sender: { name: null, address: "prn_ada@acme.example" },
    });

    const list = qc.getQueryData<readonly Workbench[]>(
      workbenchesQueryKey(TENANT, "chat"),
    );
    expect(list?.[0]?.preview).toBe("draft the agenda for Monday");
    expect(list?.[0]?.lastActivityAt).toBe("2026-01-01T00:01:00.000Z");
    expect(list?.[0]?.preview).not.toMatch(/I'm Myra/i);
  });

  test("a join/event row bumps lastActivityAt but keeps the prior preview, never blanks (CL-6795)", () => {
    const qc = client();
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [],
    } satisfies MessagesResponse);
    seedList(qc, "workbench", {
      id: WORKBENCH,
      title: "Ops",
      kind: "workbench",
      pinned: false,
      participants: [],
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      preview: "let's pull Scout in",
    });

    applyStreamMessage(qc, TENANT, WORKBENCH, {
      id: "m_join",
      createdAt: "2026-01-01T00:02:00.000Z",
      parts: [
        {
          kind: "event",
          event: "workbench.agent-joined",
          data: { address: "run_scout@acme.example" },
        },
      ],
      sender: { name: null, address: "run_scout@acme.example" },
    });

    const list = qc.getQueryData<readonly Workbench[]>(
      workbenchesQueryKey(TENANT, "workbench"),
    );
    expect(list?.[0]?.lastActivityAt).toBe("2026-01-01T00:02:00.000Z");
    expect(list?.[0]?.preview).toBe("let's pull Scout in");
  });
});

describe("applyStreamReaction", () => {
  test("adds a fresh emoji entry when the message has no reactions yet", () => {
    const qc = client();
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [baseMessage],
    } satisfies MessagesResponse);

    applyStreamReaction(
      qc,
      TENANT,
      WORKBENCH,
      { messageId: "m1", emoji: "👍", principalId: "prn_bob", added: true },
      "prn_alice",
    );

    const data = qc.getQueryData<MessagesResponse>(
      chatMessagesQueryKey(TENANT, WORKBENCH),
    );
    expect(data?.items[0]?.reactions).toEqual([
      { emoji: "👍", count: 1, reactedByMe: false },
    ]);
  });

  test("increments an existing emoji's count and flips reactedByMe for the viewer's own toggle", () => {
    const qc = client();
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [
        {
          ...baseMessage,
          reactions: [{ emoji: "👍", count: 1, reactedByMe: false }],
        },
      ],
    } satisfies MessagesResponse);

    applyStreamReaction(
      qc,
      TENANT,
      WORKBENCH,
      { messageId: "m1", emoji: "👍", principalId: "prn_alice", added: true },
      "prn_alice",
    );

    const data = qc.getQueryData<MessagesResponse>(
      chatMessagesQueryKey(TENANT, WORKBENCH),
    );
    expect(data?.items[0]?.reactions).toEqual([
      { emoji: "👍", count: 2, reactedByMe: true },
    ]);
  });

  test("removing the last reactor on an emoji drops the entry entirely", () => {
    const qc = client();
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [
        {
          ...baseMessage,
          reactions: [{ emoji: "👍", count: 1, reactedByMe: true }],
        },
      ],
    } satisfies MessagesResponse);

    applyStreamReaction(
      qc,
      TENANT,
      WORKBENCH,
      { messageId: "m1", emoji: "👍", principalId: "prn_alice", added: false },
      "prn_alice",
    );

    const data = qc.getQueryData<MessagesResponse>(
      chatMessagesQueryKey(TENANT, WORKBENCH),
    );
    expect(data?.items[0]?.reactions).toEqual([]);
  });
});

describe("applyStreamPin", () => {
  const pinnable: MessageItem = { ...baseMessage, pinned: false };

  test("pinning flips the message's own flag and adds it to the pins cache from the messages cache row", () => {
    const qc = client();
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [pinnable],
    } satisfies MessagesResponse);
    qc.setQueryData(chatPinsQueryKey(TENANT, WORKBENCH), [] as PinnedMessage[]);

    applyStreamPin(qc, TENANT, WORKBENCH, {
      messageId: "m1",
      pinned: true,
      pinnedBy: "prn_alice",
      pinnedAt: "2026-01-01T00:02:00.000Z",
    });

    const messages = qc.getQueryData<MessagesResponse>(
      chatMessagesQueryKey(TENANT, WORKBENCH),
    );
    expect(messages?.items[0]?.pinned).toBe(true);
    const pins = qc.getQueryData<readonly PinnedMessage[]>(
      chatPinsQueryKey(TENANT, WORKBENCH),
    );
    expect(pins).toEqual([
      {
        ...pinnable,
        pinned: true,
        pinnedBy: "prn_alice",
        pinnedAt: "2026-01-01T00:02:00.000Z",
      },
    ]);
  });

  test("unpinning removes it from the pins cache without a second GET /pins", () => {
    const qc = client();
    const pinnedRow: PinnedMessage = {
      ...pinnable,
      pinned: true,
      pinnedBy: "prn_alice",
      pinnedAt: "2026-01-01T00:02:00.000Z",
    };
    qc.setQueryData(chatMessagesQueryKey(TENANT, WORKBENCH), {
      items: [pinnedRow],
    } satisfies MessagesResponse);
    qc.setQueryData(chatPinsQueryKey(TENANT, WORKBENCH), [pinnedRow]);

    applyStreamPin(qc, TENANT, WORKBENCH, { messageId: "m1", pinned: false });

    const pins = qc.getQueryData<readonly PinnedMessage[]>(
      chatPinsQueryKey(TENANT, WORKBENCH),
    );
    expect(pins).toEqual([]);
  });
});
