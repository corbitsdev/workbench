import { describe, expect, test } from "bun:test";
import {
  deriveMailFocusKind,
  focusKindRank,
  isNoiseMail,
  isSystemWorkflowMail,
  selectNowCards,
  toFocusCard,
} from "./mailbox-focus";
import type { MailboxMessage } from "./mailbox";
import type { NowItem, NowRun } from "./now-feed";
import type { Task } from "./tasks";

function makeMessage(over: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: "msg-x",
    from: "Myra <myra@workbench>",
    fromDisplay: "Myra",
    to: ["you@example.com"],
    date: "2026-07-11T09:00:00.000Z",
    messageId: "mid-x",
    read: false,
    subject: "Hello",
    snippet: "Snippet",
    ...over,
  };
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-x",
    tenantId: "ten-1",
    ownerPrincipalId: "prn-1",
    createdByPrincipalId: "prn-2",
    title: "Follow up",
    status: "open",
    source: "user",
    links: [],
    externalRefs: [],
    createdAt: "2026-07-11T08:00:00.000Z",
    updatedAt: "2026-07-11T08:00:00.000Z",
    ...over,
  };
}

function makeRun(over: Partial<NowRun> = {}): NowRun {
  return {
    runId: "run-x",
    kind: "call-to-collateral",
    status: "awaiting",
    createdAt: "2026-07-11T07:00:00.000Z",
    ...over,
  };
}

describe("deriveMailFocusKind", () => {
  test("classifies quiet terminal success as system", () => {
    expect(
      deriveMailFocusKind(
        makeMessage({ subject: "Workflow run completed: granola-call" }),
      ),
    ).toBe("system");
  });

  test("classifies terminal failure as failure", () => {
    expect(
      deriveMailFocusKind(
        makeMessage({ subject: "Workflow run failed: granola-call" }),
      ),
    ).toBe("failure");
  });

  test("classifies artifact refs as artifact", () => {
    expect(
      deriveMailFocusKind(
        makeMessage({
          subject: "Deck ready",
          refs: [{ kind: "artifact", ref: "art-1" }],
        }),
      ),
    ).toBe("artifact");
  });

  test("classifies triage handoff as decision", () => {
    expect(
      deriveMailFocusKind(
        makeMessage({
          subject: "Myra triaged: Partner intro",
          refs: [{ kind: "mail", ref: "msg-raw" }],
        }),
      ),
    ).toBe("decision");
  });

  test("classifies morning brief as brief", () => {
    expect(
      deriveMailFocusKind(makeMessage({ subject: "Morning brief — Jul 11" })),
    ).toBe("brief");
  });
});

describe("isNoiseMail / isSystemWorkflowMail", () => {
  test("completed run notices are noise and never pin-eligible", () => {
    const msg = makeMessage({
      subject: "Workflow run completed: granola-call",
    });
    expect(isSystemWorkflowMail(msg)).toBe(true);
    expect(isNoiseMail(msg)).toBe(true);
  });

  test("failed run notices are not noise (they are failures)", () => {
    const msg = makeMessage({ subject: "Workflow run failed: granola-call" });
    expect(isSystemWorkflowMail(msg)).toBe(true);
    expect(isNoiseMail(msg)).toBe(false);
  });
});

describe("selectNowCards", () => {
  test("never pins quiet system success mail", () => {
    const items: NowItem[] = [
      {
        type: "mail",
        message: makeMessage({
          id: "msg-noise",
          subject: "Workflow run completed: granola-call",
        }),
        collapsed: [],
      },
      {
        type: "mail",
        message: makeMessage({
          id: "msg-brief",
          subject: "Morning brief",
          date: "2026-07-11T10:00:00.000Z",
        }),
        collapsed: [],
      },
    ];
    const cards = selectNowCards(items, 3);
    expect(cards.map((c) => c.id)).toEqual(["msg-brief"]);
  });

  test("ranks gates before failures before artifacts before tasks", () => {
    const items: NowItem[] = [
      {
        type: "task",
        task: makeTask({ id: "task-1", updatedAt: "2026-07-11T12:00:00.000Z" }),
      },
      {
        type: "mail",
        message: makeMessage({
          id: "msg-art",
          subject: "Deck ready",
          date: "2026-07-11T11:00:00.000Z",
          refs: [{ kind: "artifact", ref: "art-1" }],
        }),
        collapsed: [],
      },
      {
        type: "mail",
        message: makeMessage({
          id: "msg-fail",
          subject: "Workflow run failed: x",
          date: "2026-07-11T10:00:00.000Z",
        }),
        collapsed: [],
      },
      {
        type: "gate",
        run: makeRun({ runId: "run-1", createdAt: "2026-07-11T09:00:00.000Z" }),
      },
    ];
    const cards = selectNowCards(items, 4);
    expect(cards.map((c) => c.id)).toEqual([
      "run-1",
      "msg-fail",
      "msg-art",
      "task-1",
    ]);
    expect(focusKindRank(cards[0]!.kind)).toBeLessThan(
      focusKindRank(cards[1]!.kind),
    );
  });

  test("hard-caps at three cards", () => {
    const items: NowItem[] = Array.from({ length: 6 }, (_, i) => ({
      type: "mail" as const,
      message: makeMessage({
        id: `msg-${i}`,
        subject: `Deck ready ${i}`,
        date: `2026-07-11T0${i}:00:00.000Z`,
        refs: [{ kind: "artifact", ref: `art-${i}` }],
      }),
      collapsed: [],
    }));
    expect(selectNowCards(items, 3)).toHaveLength(3);
  });

  test("never pins later-priority generic mail into Now", () => {
    const items: NowItem[] = Array.from({ length: 4 }, (_, i) => ({
      type: "mail" as const,
      message: makeMessage({
        id: `noise-${i}`,
        subject: `Generic note ${i}`,
        date: `2026-07-11T0${i}:00:00.000Z`,
      }),
      collapsed: [],
    }));
    expect(selectNowCards(items, 3)).toEqual([]);
  });

  test("toFocusCard returns null for system noise", () => {
    expect(
      toFocusCard({
        type: "mail",
        message: makeMessage({
          subject: "Workflow run completed: granola-call",
        }),
        collapsed: [],
      }),
    ).toBeNull();
  });
});
