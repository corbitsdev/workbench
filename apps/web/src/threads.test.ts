import { describe, expect, test } from "bun:test";

import {
  buildForkReference,
  deriveDmThreads,
  deriveThreads,
  isDuplicateMessageId,
  participantsOf,
  type ThreadMessage,
} from "./threads";

function message(
  messageId: string,
  from: string,
  to: string[],
  extra?: Partial<ThreadMessage>,
): ThreadMessage {
  return { messageId, from, to, ...extra };
}

describe("thread grouping", () => {
  test("groups List-ID members into one M:N thread across subjects", () => {
    const threads = deriveThreads([
      message("<a@example>", "ada@example.com", ["myra@example.com"], {
        subject: "Atlas kickoff",
        listId: "atlas.example",
      }),
      message("<b@example>", "myra@example.com", ["ada@example.com"], {
        subject: "Something entirely different",
        listId: "atlas.example",
      }),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      key: "list:atlas.example",
      rootMessageId: "<a@example>",
      messageIds: ["<a@example>", "<b@example>"],
    });
  });

  test("chains In-Reply-To/References replies under their root", () => {
    const threads = deriveThreads([
      message("<root@example>", "ada@example.com", ["myra@example.com"], {
        subject: "Hello",
      }),
      message("<reply@example>", "myra@example.com", ["ada@example.com"], {
        subject: "Re: Hello",
        inReplyTo: "<root@example>",
        references: ["<root@example>"],
      }),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      rootMessageId: "<root@example>",
      messageIds: ["<root@example>", "<reply@example>"],
    });
  });

  test("falls back to normalized subject when no List-ID or reply chain exists", () => {
    const threads = deriveThreads([
      message("<a@example>", "ada@example.com", ["myra@example.com"], {
        subject: "Status update",
      }),
      message("<b@example>", "myra@example.com", ["ada@example.com"], {
        subject: "Re:  STATUS update",
      }),
      message("<c@example>", "ada@example.com", ["myra@example.com"], {
        subject: "Unrelated",
      }),
    ]);

    expect(threads.map((thread) => thread.messageIds)).toEqual([
      ["<a@example>", "<b@example>"],
      ["<c@example>"],
    ]);
  });

  test("keeps subject-less, link-less messages solo", () => {
    const threads = deriveThreads([
      message("<a@example>", "ada@example.com", ["myra@example.com"]),
      message("<b@example>", "ada@example.com", ["myra@example.com"]),
    ]);

    expect(threads.map((thread) => thread.messageIds)).toEqual([["<a@example>"], ["<b@example>"]]);
  });

  test("keeps same-subject messages with distinct correspondents separate", () => {
    const threads = deriveThreads([
      message("<a@example>", "ada@example.com", ["myra@example.com"], {
        subject: "Hello",
      }),
      message("<b@example>", "ada@example.com", ["reviewer@example.com"], {
        subject: "Re: hello",
      }),
    ]);

    expect(threads.map((thread) => thread.messageIds)).toEqual([["<a@example>"], ["<b@example>"]]);
  });

  test("scopes the subject fallback to a single participant set", () => {
    const threads = deriveThreads([
      message("<a@example>", "ada@example.com", ["myra@example.com"], {
        subject: "Status update",
      }),
      message("<b@example>", "myra@example.com", ["ada@example.com"], {
        subject: "Re: STATUS update",
      }),
      message("<c@example>", "ada@example.com", ["reviewer@example.com"], {
        subject: "status update",
      }),
    ]);

    expect(threads.map((thread) => thread.messageIds)).toEqual([
      ["<a@example>", "<b@example>"],
      ["<c@example>"],
    ]);
  });
});

describe("DM derivation from participant-filtered threads", () => {
  const user = ["ada@example.com"];

  test("derives one DM per thread between the user and exactly one agent chain", () => {
    const threads = deriveDmThreads(
      [
        message("<a@example>", "ada@example.com", ["myra@example.com"], {
          subject: "Hi",
        }),
        message("<b@example>", "myra@example.com", ["ada@example.com"], {
          subject: "Re: Hi",
          inReplyTo: "<a@example>",
          references: ["<a@example>"],
        }),
        message("<c@example>", "ada@example.com", ["reviewer@example.com"], {
          subject: "Review",
        }),
      ],
      user,
    );

    expect(threads).toEqual([
      {
        agentAddress: "myra@example.com",
        rootMessageId: "<a@example>",
        messageIds: ["<a@example>", "<b@example>"],
      },
      {
        agentAddress: "reviewer@example.com",
        rootMessageId: "<c@example>",
        messageIds: ["<c@example>"],
      },
    ]);
  });

  test("keeps distinct 1:1 pairs sharing a subject as separate DMs", () => {
    const threads = deriveDmThreads(
      [
        message("<a@example>", "ada@example.com", ["myra@example.com"], {
          subject: "Hello",
        }),
        message("<b@example>", "ada@example.com", ["reviewer@example.com"], {
          subject: "Re: hello",
        }),
      ],
      user,
    );

    expect(threads).toEqual([
      {
        agentAddress: "myra@example.com",
        rootMessageId: "<a@example>",
        messageIds: ["<a@example>"],
      },
      {
        agentAddress: "reviewer@example.com",
        rootMessageId: "<b@example>",
        messageIds: ["<b@example>"],
      },
    ]);
  });

  test("excludes group threads, user-only threads, and agent-only threads", () => {
    const threads = deriveDmThreads(
      [
        message("<group@example>", "ada@example.com", ["myra@example.com", "reviewer@example.com"]),
        message("<solo@example>", "ada@example.com", ["ada@example.com"]),
        message("<agents@example>", "myra@example.com", ["reviewer@example.com"]),
      ],
      user,
    );

    expect(threads).toEqual([]);
  });

  test("matches addresses case-insensitively across To and Cc", () => {
    const direct = deriveDmThreads(
      [
        message("<a@example>", "Myra@Example.com", ["ADA@example.com"], {
          cc: ["MYRA@example.com"],
        }),
      ],
      user,
    );

    expect(direct).toEqual([
      {
        agentAddress: "myra@example.com",
        rootMessageId: "<a@example>",
        messageIds: ["<a@example>"],
      },
    ]);
  });
});

describe("participants", () => {
  test("unions From, To, and Cc into one membership set", () => {
    expect(
      participantsOf(
        message("<a@example>", "ada@example.com", ["myra@example.com"], {
          cc: ["bea@example.com"],
        }),
      ),
    ).toEqual(new Set(["ada@example.com", "myra@example.com", "bea@example.com"]));
  });
});

describe("sub-thread forking", () => {
  test("builds native In-Reply-To/References ancestry for the fork", () => {
    expect(
      buildForkReference({
        messageId: "<parent@example>",
        references: ["<root@example>", "<parent@example>"],
      }),
    ).toEqual({
      inReplyTo: "<parent@example>",
      references: ["<root@example>", "<parent@example>"],
    });
  });

  test("starts a fresh chain when the parent carries no references", () => {
    expect(buildForkReference({ messageId: "<solo@example>" })).toEqual({
      inReplyTo: "<solo@example>",
      references: ["<solo@example>"],
    });
  });
});

describe("native Message-ID idempotency", () => {
  test("treats a returned Message-ID seen before as a duplicate send", () => {
    expect(isDuplicateMessageId(["<a@example>"], "<a@example>")).toBe(true);
    expect(isDuplicateMessageId(["<a@example>"], "<b@example>")).toBe(false);
    expect(isDuplicateMessageId([], "<b@example>")).toBe(false);
  });
});
