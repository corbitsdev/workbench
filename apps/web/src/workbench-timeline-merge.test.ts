import { describe, expect, test } from "bun:test";
import type { WorkbenchThread, MessageItem } from "@corbits/chat-ui";
import type { Task } from "@corbits/tasks-ui";

import type { NeedsYouItem } from "./api";
import type { Routine, RoutineRun } from "./routines-api";
import {
  computeTimelineDayKpis,
  filterTimelineEvents,
  groupTimelineByDay,
  mergeTimelineEvents,
  routineRunDurationMs,
  routineRunStatus,
  routinesForWorkbench,
  toApprovalEvents,
  toMessageEvents,
  toRoutineRunEvents,
  toTaskEvents,
  toThreadForkEvents,
  type TimelineEvent,
} from "./workbench-timeline-merge";

function message(overrides: Partial<MessageItem> = {}): MessageItem {
  return {
    id: "msg-1",
    createdAt: "2026-08-17T10:00:00.000Z",
    parts: [{ kind: "text", text: "hello there" }],
    sender: { name: "Sawyer", address: "sawyer@bench-1" },
    ...overrides,
  } as MessageItem;
}

function thread(overrides: Partial<WorkbenchThread> = {}): WorkbenchThread {
  return {
    id: "thread-1",
    kind: "reply",
    parentMessageId: "msg-1",
    parentThreadId: null,
    runRef: null,
    title: "A fork",
    createdAt: "2026-08-17T10:05:00.000Z",
    ...overrides,
  } as WorkbenchThread;
}

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    name: "Daily digest",
    definitionId: "def-1",
    trigger: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
    scope: "bench",
    input: {},
    enabled: true,
    deliveryWorkbenchId: "workbench-1",
    consecutiveFailures: 0,
    deadLetteredAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as Routine;
}

function routineRun(overrides: Partial<RoutineRun> = {}): RoutineRun {
  return {
    runId: "run-1",
    triggeredBy: "schedule",
    createdAt: "2026-08-17T09:00:00.000Z",
    run: {
      status: "deployed",
      createdAt: "2026-08-17T09:00:00.000Z",
      endedAt: "2026-08-17T09:02:00.000Z",
    },
    ...overrides,
  } as RoutineRun;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    definitionId: "def-1",
    workbenchId: "workbench-1",
    agentName: "Researcher",
    prompt: "Summarize the thread",
    modelPreference: null,
    status: "done",
    runId: "run-2",
    runIds: ["run-2"],
    stepCount: 1,
    resultMailId: null,
    createdAt: "2026-08-17T11:00:00.000Z",
    completedAt: "2026-08-17T11:05:00.000Z",
    ...overrides,
  } as Task;
}

function approval(overrides: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id: "approval-1",
    agentName: "Researcher",
    benchName: "Acme",
    headline: "Send the email",
    arguments: {},
    status: "pending",
    createdAt: "2026-08-17T12:00:00.000Z",
    ...overrides,
  } as NeedsYouItem;
}

describe("toMessageEvents", () => {
  test("joins text parts and truncates the excerpt at 120 chars", () => {
    const long = "a".repeat(200);
    const [event] = toMessageEvents([
      message({ parts: [{ kind: "text", text: long }] }),
    ]);
    expect(event?.excerpt.length).toBe(121);
    expect(event?.excerpt.endsWith("…")).toBe(true);
  });

  test("falls back to the sender's local part, never the raw address", () => {
    const [event] = toMessageEvents([
      message({ sender: { name: null, address: "echo@workbench-1" } }),
    ]);
    expect(event?.senderName).toBe("echo");
  });

  test("marks an agent sender via its @-shaped address", () => {
    const [event] = toMessageEvents([
      message({ sender: { name: null, address: "researcher@workbench-1" } }),
    ]);
    expect(event?.isAgent).toBe(true);
  });

  test("marks a human sender (no @) as not an agent", () => {
    const [event] = toMessageEvents([
      message({ sender: { name: "Sawyer", address: "principal-123" } }),
    ]);
    expect(event?.isAgent).toBe(false);
  });

  test("empty parts render an honest placeholder, never a blank excerpt", () => {
    const [event] = toMessageEvents([message({ parts: [] })]);
    expect(event?.excerpt).toBe("(no text)");
  });
});

describe("toThreadForkEvents", () => {
  test("drops the root thread", () => {
    const events = toThreadForkEvents([
      thread({ id: "root-1", kind: "root" }),
      thread({ id: "fork-1", kind: "reply" }),
    ]);
    expect(events.map((e) => e.id)).toEqual(["fork-1"]);
  });

  test("titles a fork with no title 'Thread'", () => {
    const [event] = toThreadForkEvents([thread({ title: null })]);
    expect(event?.title).toBe("Thread");
  });
});

describe("routine run derivation", () => {
  test("an error field always means failed", () => {
    expect(routineRunStatus(routineRun({ error: "boom" }))).toBe("failed");
  });

  test("reads status off the embedded run record", () => {
    expect(routineRunStatus(routineRun({ run: { status: "running" } }))).toBe(
      "running",
    );
    expect(routineRunStatus(routineRun({ run: { status: "error" } }))).toBe(
      "failed",
    );
    expect(routineRunStatus(routineRun({ run: { status: "deployed" } }))).toBe(
      "ok",
    );
  });

  test("computes duration only when the record carries endedAt", () => {
    expect(routineRunDurationMs(routineRun())).toBe(120_000);
    expect(
      routineRunDurationMs(routineRun({ run: { status: "running" } })),
    ).toBeNull();
  });
});

describe("routinesForWorkbench", () => {
  test("keeps only routines that deliver into this workbench", () => {
    const routines = [
      routine({ id: "r1", deliveryWorkbenchId: "workbench-1" }),
      routine({ id: "r2", deliveryWorkbenchId: "workbench-2" }),
    ];
    expect(
      routinesForWorkbench(routines, "workbench-1").map((r) => r.id),
    ).toEqual(["r1"]);
  });
});

describe("toRoutineRunEvents", () => {
  test("joins each routine's runs by id", () => {
    const routines = [routine({ id: "r1", name: "Daily digest" })];
    const runsByRoutineId = new Map([["r1", [routineRun()]]]);
    const [event] = toRoutineRunEvents(routines, runsByRoutineId);
    expect(event).toMatchObject({
      kind: "routine-run",
      routineName: "Daily digest",
      runId: "run-1",
      status: "ok",
      durationMs: 120_000,
    });
  });
});

describe("toTaskEvents", () => {
  test("filters to this workbench's workbenchId", () => {
    const tasks = [
      task({ id: "t1", workbenchId: "workbench-1" }),
      task({ id: "t2", workbenchId: "workbench-2" }),
      task({ id: "t3", workbenchId: null }),
    ];
    expect(toTaskEvents(tasks, "workbench-1").map((e) => e.id)).toEqual(["t1"]);
  });
});

describe("toApprovalEvents", () => {
  test("carries every pending approval through unfiltered", () => {
    const events = toApprovalEvents([approval()]);
    expect(events).toEqual([
      {
        kind: "approval",
        id: "approval-1",
        at: "2026-08-17T12:00:00.000Z",
        agentName: "Researcher",
        headline: "Send the email",
      },
    ]);
  });
});

describe("mergeTimelineEvents", () => {
  test("sorts every kind onto one oldest-first spine", () => {
    const merged = mergeTimelineEvents({
      messages: toMessageEvents([
        message({ id: "m1", createdAt: "2026-08-17T10:00:00.000Z" }),
      ]),
      threadForks: toThreadForkEvents([
        thread({ id: "f1", createdAt: "2026-08-17T09:30:00.000Z" }),
      ]),
      routineRuns: toRoutineRunEvents(
        [routine({ id: "r1" })],
        new Map([
          [
            "r1",
            [
              routineRun({
                runId: "run-1",
                createdAt: "2026-08-17T08:00:00.000Z",
              }),
            ],
          ],
        ]),
      ),
      tasks: toTaskEvents(
        [task({ id: "t1", createdAt: "2026-08-17T11:00:00.000Z" })],
        "workbench-1",
      ),
      approvals: toApprovalEvents([
        approval({ id: "a1", createdAt: "2026-08-17T12:00:00.000Z" }),
      ]),
    });
    expect(merged.map((e) => e.id)).toEqual(["run-1", "f1", "m1", "t1", "a1"]);
  });

  test("drops an event with an unparseable timestamp instead of sorting it arbitrarily", () => {
    const merged = mergeTimelineEvents({
      messages: toMessageEvents([
        message({ id: "m1", createdAt: "not-a-date" }),
      ]),
      threadForks: [],
      routineRuns: [],
      tasks: [],
      approvals: [],
    });
    expect(merged).toEqual([]);
  });
});

describe("groupTimelineByDay", () => {
  test("buckets an already-sorted spine by UTC calendar day, oldest day first", () => {
    const events: TimelineEvent[] = [
      {
        kind: "message",
        id: "m1",
        at: "2026-08-16T23:00:00.000Z",
        senderName: "A",
        excerpt: "x",
        isAgent: false,
      },
      {
        kind: "message",
        id: "m2",
        at: "2026-08-17T01:00:00.000Z",
        senderName: "A",
        excerpt: "y",
        isAgent: false,
      },
      {
        kind: "message",
        id: "m3",
        at: "2026-08-17T02:00:00.000Z",
        senderName: "A",
        excerpt: "z",
        isAgent: false,
      },
    ];
    const groups = groupTimelineByDay(events);
    expect(groups.map((g) => g.day)).toEqual(["2026-08-16", "2026-08-17"]);
    expect(groups[0]?.events.map((e) => e.id)).toEqual(["m1"]);
    expect(groups[1]?.events.map((e) => e.id)).toEqual(["m2", "m3"]);
  });
});

describe("computeTimelineDayKpis", () => {
  test("counts messages, agent turns, routine runs, and approvals per day", () => {
    const events: TimelineEvent[] = [
      {
        kind: "message",
        id: "m1",
        at: "2026-08-17T09:00:00.000Z",
        senderName: "A",
        excerpt: "x",
        isAgent: false,
      },
      {
        kind: "message",
        id: "m2",
        at: "2026-08-17T09:05:00.000Z",
        senderName: "researcher",
        excerpt: "y",
        isAgent: true,
      },
      {
        kind: "routine-run",
        id: "run-1",
        at: "2026-08-17T09:10:00.000Z",
        routineName: "Digest",
        runId: "run-1",
        status: "ok",
        durationMs: null,
      },
      {
        kind: "approval",
        id: "a1",
        at: "2026-08-17T09:15:00.000Z",
        agentName: "Researcher",
        headline: "Do it",
      },
      {
        kind: "task",
        id: "t1",
        at: "2026-08-17T09:20:00.000Z",
        agentName: "Researcher",
        prompt: "p",
        status: "done",
      },
      {
        kind: "thread-fork",
        id: "f1",
        at: "2026-08-17T09:25:00.000Z",
        threadKind: "reply",
        title: "Fork",
        parentMessageId: null,
      },
    ];
    const [kpi] = computeTimelineDayKpis(events);
    expect(kpi).toMatchObject({
      messages: 2,
      agentTurns: 1,
      routineRuns: 1,
      approvals: 1,
    });
  });
});

describe("filterTimelineEvents", () => {
  const events: TimelineEvent[] = [
    {
      kind: "message",
      id: "m1",
      at: "2026-08-17T09:00:00.000Z",
      senderName: "A",
      excerpt: "x",
      isAgent: false,
    },
    {
      kind: "thread-fork",
      id: "f1",
      at: "2026-08-17T09:01:00.000Z",
      threadKind: "reply",
      title: "Fork",
      parentMessageId: null,
    },
    {
      kind: "routine-run",
      id: "run-1",
      at: "2026-08-17T09:02:00.000Z",
      routineName: "Digest",
      runId: "run-1",
      status: "ok",
      durationMs: null,
    },
    {
      kind: "task",
      id: "t1",
      at: "2026-08-17T09:03:00.000Z",
      agentName: "Researcher",
      prompt: "p",
      status: "done",
    },
    {
      kind: "approval",
      id: "a1",
      at: "2026-08-17T09:04:00.000Z",
      agentName: "Researcher",
      headline: "Do it",
    },
  ];

  test("all keeps everything", () => {
    expect(filterTimelineEvents(events, "all")).toHaveLength(5);
  });

  test("messages keeps messages and thread forks", () => {
    expect(filterTimelineEvents(events, "messages").map((e) => e.id)).toEqual([
      "m1",
      "f1",
    ]);
  });

  test("runs keeps routine runs and tasks", () => {
    expect(filterTimelineEvents(events, "runs").map((e) => e.id)).toEqual([
      "run-1",
      "t1",
    ]);
  });

  test("approvals keeps only approvals", () => {
    expect(filterTimelineEvents(events, "approvals").map((e) => e.id)).toEqual([
      "a1",
    ]);
  });
});
