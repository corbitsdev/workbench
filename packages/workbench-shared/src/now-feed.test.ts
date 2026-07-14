import { describe, expect, test } from "bun:test";
import { buildNowFeed, type NowRun } from "./now-feed";
import type { MailboxMessage } from "./mailbox";
import type { Task } from "./tasks";

function makeMessage(over: Partial<MailboxMessage>): MailboxMessage {
  return {
    id: "msg-x",
    from: "Myra <myra@workbench>",
    to: ["you@example.com"],
    date: "2026-07-11T09:00:00.000Z",
    messageId: "mid-x",
    read: false,
    ...over,
  };
}

function makeTask(over: Partial<Task>): Task {
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

function makeRun(over: Partial<NowRun>): NowRun {
  return {
    runId: "run-x",
    kind: "call-to-collateral",
    status: "awaiting",
    createdAt: "2026-07-11T07:00:00.000Z",
    ...over,
  };
}

describe("buildNowFeed", () => {
  test("orders awaiting gates before unread mail before open tasks", () => {
    const feed = buildNowFeed({
      runs: [makeRun({ runId: "run-1" })],
      messages: [makeMessage({ id: "msg-1", subject: "Morning brief" })],
      tasks: [makeTask({ id: "task-1" })],
    });
    expect(feed.map((item) => item.type)).toEqual(["gate", "mail", "task"]);
  });

  test("drops responded gates, read mail, and finished tasks", () => {
    const feed = buildNowFeed({
      runs: [
        makeRun({ runId: "run-1", status: "running" }),
        makeRun({ runId: "run-2", status: "completed" }),
        makeRun({ runId: "run-3", status: "failed" }),
      ],
      messages: [makeMessage({ id: "msg-1", read: true })],
      tasks: [
        makeTask({ id: "task-1", status: "done" }),
        makeTask({ id: "task-2", status: "cancelled" }),
      ],
    });
    expect(feed).toEqual([]);
  });

  test("keeps open, in_progress, and waiting tasks", () => {
    const feed = buildNowFeed({
      runs: [],
      messages: [],
      tasks: [
        makeTask({ id: "task-1", status: "open" }),
        makeTask({ id: "task-2", status: "in_progress" }),
        makeTask({ id: "task-3", status: "waiting" }),
      ],
    });
    expect(feed).toHaveLength(3);
  });

  test("sorts each group newest first", () => {
    const feed = buildNowFeed({
      runs: [
        makeRun({ runId: "run-old", createdAt: "2026-07-10T00:00:00.000Z" }),
        makeRun({ runId: "run-new", createdAt: "2026-07-11T00:00:00.000Z" }),
      ],
      messages: [
        makeMessage({ id: "msg-old", date: "2026-07-10T00:00:00.000Z" }),
        makeMessage({ id: "msg-new", date: "2026-07-11T00:00:00.000Z" }),
      ],
      tasks: [
        makeTask({ id: "task-old", updatedAt: "2026-07-10T00:00:00.000Z" }),
        makeTask({ id: "task-new", updatedAt: "2026-07-11T00:00:00.000Z" }),
      ],
    });
    const ids = feed.map((item) => {
      if (item.type === "gate") return item.run.runId;
      if (item.type === "mail") return item.message.id;
      return item.task.id;
    });
    expect(ids).toEqual([
      "run-new",
      "run-old",
      "msg-new",
      "msg-old",
      "task-new",
      "task-old",
    ]);
  });

  test("collapses the raw item behind an unread triage handoff via its mail ref", () => {
    const raw = makeMessage({
      id: "msg-raw",
      subject: "Pricing question from Acme",
      read: false,
    });
    const handoff = makeMessage({
      id: "msg-handoff",
      subject: "Myra triaged: Pricing question from Acme",
      date: "2026-07-11T10:00:00.000Z",
      refs: [{ kind: "mail", ref: "msg-raw", label: "Open original" }],
    });
    const feed = buildNowFeed({
      runs: [],
      messages: [raw, handoff],
      tasks: [],
    });
    expect(feed).toHaveLength(1);
    const item = feed[0];
    if (item?.type !== "mail") throw new Error("expected a mail item");
    expect(item.message.id).toBe("msg-handoff");
    expect(item.collapsed.map((m) => m.id)).toEqual(["msg-raw"]);
  });

  test("collapses a legacy handoff with no refs via the subject-prefix fallback", () => {
    // Simulates a mailbox row written before CL-3507 shipped: no refs field
    // at all, only the old subject convention. Must still collapse.
    const raw = makeMessage({
      id: "msg-raw",
      subject: "Pricing question from Acme",
      read: false,
    });
    const handoff = makeMessage({
      id: "msg-handoff",
      subject: "Myra triaged: Pricing question from Acme",
      date: "2026-07-11T10:00:00.000Z",
    });
    const feed = buildNowFeed({
      runs: [],
      messages: [raw, handoff],
      tasks: [],
    });
    expect(feed).toHaveLength(1);
    const item = feed[0];
    if (item?.type !== "mail") throw new Error("expected a mail item");
    expect(item.message.id).toBe("msg-handoff");
    expect(item.collapsed.map((m) => m.id)).toEqual(["msg-raw"]);
  });

  test("a read handoff does not collapse the raw item", () => {
    const raw = makeMessage({ id: "msg-raw", subject: "Pricing question" });
    const handoff = makeMessage({
      id: "msg-handoff",
      subject: "Myra triaged: Pricing question",
      read: true,
      refs: [{ kind: "mail", ref: "msg-raw", label: "Open original" }],
    });
    const feed = buildNowFeed({
      runs: [],
      messages: [raw, handoff],
      tasks: [],
    });
    expect(feed).toHaveLength(1);
    const item = feed[0];
    if (item?.type !== "mail") throw new Error("expected a mail item");
    expect(item.message.id).toBe("msg-raw");
  });

  test("returns an empty feed for empty inputs", () => {
    expect(buildNowFeed({ runs: [], messages: [], tasks: [] })).toEqual([]);
  });
});
