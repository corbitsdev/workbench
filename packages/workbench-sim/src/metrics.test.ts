import { describe, expect, test } from "bun:test";

import {
  assertRun,
  computeMetrics,
  droppedMessages,
  percentile,
  threadViolations,
  type CollectedRun,
  type SentMessage,
} from "./metrics";

const send = (overrides: Partial<SentMessage>): SentMessage => ({
  actor: "a",
  text: "t",
  messageId: "m",
  latencyMs: 10,
  ...overrides,
});

describe("percentile", () => {
  test("p50/p95 over a spread", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
  });
  test("empty input is 0", () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe("droppedMessages", () => {
  test("finds sends missing from the timeline", () => {
    const sent = [send({ messageId: "m1" }), send({ messageId: "m2" })];
    expect(droppedMessages(sent, new Set(["m1"]))).toHaveLength(1);
    expect(droppedMessages(sent, new Set(["m1", "m2"]))).toHaveLength(0);
  });
});

describe("threadViolations", () => {
  test("replies to one root sharing a thread are intact", () => {
    const sent = [
      send({ messageId: "r1", inReplyToMessageId: "root", threadId: "t1" }),
      send({ messageId: "r2", inReplyToMessageId: "root", threadId: "t1" }),
    ];
    expect(threadViolations(sent)).toEqual([]);
  });
  test("a reply landing in another thread is a violation", () => {
    const sent = [
      send({ messageId: "r1", inReplyToMessageId: "root", threadId: "t1" }),
      send({ messageId: "r2", inReplyToMessageId: "root", threadId: "t2" }),
    ];
    expect(threadViolations(sent)).toHaveLength(1);
  });
  test("a reply with no threadId is a violation", () => {
    const sent = [send({ messageId: "r1", inReplyToMessageId: "root" })];
    expect(threadViolations(sent)).toHaveLength(1);
  });
  test("two roots sharing one thread is a violation", () => {
    const sent = [
      send({ messageId: "r1", inReplyToMessageId: "rootA", threadId: "t1" }),
      send({ messageId: "r2", inReplyToMessageId: "rootB", threadId: "t1" }),
    ];
    expect(threadViolations(sent)).toHaveLength(1);
  });
});

function greenRun(): CollectedRun {
  const sent: SentMessage[] = [];
  for (let index = 0; index < 100; index += 1) {
    sent.push(send({ messageId: `m${index}`, latencyMs: index + 1 }));
  }
  for (let index = 0; index < 20; index += 1) {
    sent.push(
      send({
        messageId: `r${index}`,
        inReplyToMessageId: "m0",
        threadId: "t0",
        latencyMs: 5,
      }),
    );
  }
  return {
    scenarioName: "t",
    sent,
    timelineMessageIds: new Set(sent.map((message) => message.messageId)),
    routineFires: Array.from({ length: 10 }, (_, index) => ({
      routine: "daily",
      runId: `run${index}`,
      accepted: true,
    })),
    dbRowsBefore: 100,
    dbRowsAfter: 400,
    wallClockMs: 60_000,
  };
}

describe("computeMetrics + assertRun", () => {
  test("a healthy run is all green", () => {
    const metrics = computeMetrics(greenRun());
    expect(metrics.messageCount).toBe(120);
    expect(metrics.threadReplyCount).toBe(20);
    expect(metrics.dropCount).toBe(0);
    expect(metrics.dbRowGrowth).toBe(300);
    expect(metrics.latencyP50Ms).toBeGreaterThan(0);
    const assertions = assertRun(metrics, {
      minMessages: 100,
      minThreadReplies: 20,
      minRoutineFires: 10,
    });
    expect(assertions.every((assertion) => assertion.pass)).toBe(true);
  });

  test("a dropped send and a rejected fire go red", () => {
    const run = greenRun();
    const timeline = new Set(run.timelineMessageIds);
    timeline.delete("m3");
    const broken: CollectedRun = {
      ...run,
      timelineMessageIds: timeline,
      routineFires: [
        ...run.routineFires.slice(0, 9),
        { routine: "daily", runId: "", accepted: false },
      ],
    };
    const assertions = assertRun(computeMetrics(broken), {
      minMessages: 100,
      minThreadReplies: 20,
      minRoutineFires: 10,
    });
    const failed = assertions.filter((assertion) => !assertion.pass);
    expect(failed.map((assertion) => assertion.name).sort()).toEqual([
      "no drops",
      "routine fires",
    ]);
  });
});
