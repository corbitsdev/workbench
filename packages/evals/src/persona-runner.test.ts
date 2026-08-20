import { expect, test } from "bun:test";

import { runPersonaStep } from "./persona-runner.ts";
import type { PersonaBrief, PersonaEvalStep, Target, Turn } from "./types.ts";

const brief: PersonaBrief = {
  name: "Dana",
  goal: "get a daily digest set up",
  knownFacts: { cadence: "every weekday at 8am" },
};

function scriptedTarget(replies: Record<string, Turn>): Target {
  return {
    configName: "test",
    async sendTurn(human) {
      const turn = replies[human];
      if (turn === undefined) {
        throw new Error(`scriptedTarget: no reply scripted for "${human}"`);
      }
      return turn;
    },
    async close() {},
  };
}

test("stops when the agent's reply carries no question", async () => {
  const target = scriptedTarget({
    "set up my digest": {
      human: "set up my digest",
      replyText: "Done — your digest is set up.",
      toolCalls: [],
    },
  });
  const step: PersonaEvalStep = {
    kind: "persona",
    opening: "set up my digest",
    persona: brief,
    maxTurns: 5,
    expect: [],
  };
  let callCount = 0;
  const call = async () => {
    callCount += 1;
    return { text: "should not be reached" };
  };

  const turns = await runPersonaStep(step, target, call);

  expect(turns).toHaveLength(1);
  expect(turns[0]?.replyText).toBe("Done — your digest is set up.");
  expect(callCount).toBe(0);
});

test("stops when the persona replies DONE", async () => {
  const target = scriptedTarget({
    "set up my digest": {
      human: "set up my digest",
      replyText: "What cadence works for you?",
      toolCalls: [],
    },
  });
  const step: PersonaEvalStep = {
    kind: "persona",
    opening: "set up my digest",
    persona: brief,
    maxTurns: 5,
    expect: [],
  };
  const call = async () => ({ text: "DONE" });

  const turns = await runPersonaStep(step, target, call);

  expect(turns).toHaveLength(1);
});

test("stops at maxTurns even if the agent keeps asking questions", async () => {
  let questionCount = 0;
  const target: Target = {
    configName: "test",
    async sendTurn() {
      questionCount += 1;
      return {
        human: `turn ${String(questionCount)}`,
        replyText: "What else can you tell me?",
        toolCalls: [],
      };
    },
    async close() {},
  };
  const step: PersonaEvalStep = {
    kind: "persona",
    opening: "set up my digest",
    persona: brief,
    maxTurns: 3,
    expect: [],
  };
  const call = async () => ({ text: "here's more info" });

  const turns = await runPersonaStep(step, target, call);

  expect(turns).toHaveLength(3);
});

test("feeds the persona's answer back into the next sendTurn call", async () => {
  const sentHumans: string[] = [];
  let turnCount = 0;
  const target: Target = {
    configName: "test",
    async sendTurn(human) {
      sentHumans.push(human);
      turnCount += 1;
      if (turnCount === 1) {
        return {
          human,
          replyText: "What cadence works for you?",
          toolCalls: [],
        };
      }
      return { human, replyText: "Great, all set.", toolCalls: [] };
    },
    async close() {},
  };
  const step: PersonaEvalStep = {
    kind: "persona",
    opening: "set up my digest",
    persona: brief,
    maxTurns: 5,
    expect: [],
  };
  const call = async () => ({ text: "every weekday at 8am" });

  await runPersonaStep(step, target, call);

  expect(sentHumans).toEqual(["set up my digest", "every weekday at 8am"]);
});
