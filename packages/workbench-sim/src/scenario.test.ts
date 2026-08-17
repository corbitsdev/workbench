import { describe, expect, test } from "bun:test";

import {
  humanSay,
  label,
  routineFire,
  summarizeScenario,
  validateScenario,
  waitQuiet,
  type Scenario,
} from "./scenario";
import { busyTeamWeek } from "./scenarios/busy-team-week";

describe("summarizeScenario", () => {
  test("counts messages, replies, fires, and labels", () => {
    const scenario: Scenario = {
      name: "t",
      description: "",
      humans: { a: "A" },
      agents: [],
      routines: [{ key: "r", name: "R", workflow: "heartbeat" }],
      steps: [
        label("day 1"),
        humanSay("a", "root", { ref: "m1" }),
        humanSay("a", "reply", { inReplyToRef: "m1" }),
        routineFire("r"),
        waitQuiet(10),
      ],
    };
    expect(summarizeScenario(scenario)).toEqual({
      messages: 2,
      threadReplies: 1,
      routineFires: 1,
      labels: ["day 1"],
    });
  });
});

describe("validateScenario", () => {
  test("flags unknown actors, dangling refs, unknown routines and mentions", () => {
    const scenario: Scenario = {
      name: "bad",
      description: "",
      humans: { a: "A" },
      agents: [{ key: "scout", workflow: "echo" }],
      routines: [],
      steps: [
        humanSay("ghost", "hi"),
        humanSay("a", "reply", { inReplyToRef: "never" }),
        humanSay("a", "ping", { mentions: ["nobody"] }),
        routineFire("missing"),
      ],
    };
    const problems = validateScenario(scenario);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('unknown actor "ghost"');
    expect(problems[1]).toContain('"never" names no earlier ref');
    expect(problems[2]).toContain('unknown mention "nobody"');
    expect(problems[3]).toContain('unknown routine "missing"');
  });

  test("flags duplicate refs", () => {
    const scenario: Scenario = {
      name: "dup",
      description: "",
      humans: { a: "A" },
      agents: [],
      routines: [],
      steps: [
        humanSay("a", "one", { ref: "m" }),
        humanSay("a", "two", { ref: "m" }),
      ],
    };
    expect(validateScenario(scenario)).toHaveLength(1);
  });
});

describe("busy-team-week", () => {
  test("meets its own volume claims and is valid", () => {
    const shape = summarizeScenario(busyTeamWeek);
    expect(shape.messages).toBeGreaterThanOrEqual(100);
    expect(shape.threadReplies).toBeGreaterThanOrEqual(20);
    expect(shape.routineFires).toBeGreaterThanOrEqual(10);
    expect(shape.labels).toEqual(["day 1", "day 2", "day 3", "day 4", "day 5"]);
    expect(validateScenario(busyTeamWeek)).toEqual([]);
  });
});
