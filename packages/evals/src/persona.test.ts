import { expect, test } from "bun:test";

import { personaAnswer } from "./persona.ts";
import type { PersonaBrief } from "./types.ts";

const brief: PersonaBrief = {
  name: "Dana",
  goal: "get a daily AI news digest set up",
  knownFacts: {
    cadence: "every weekday morning at 8am",
    sources: "The Verge, TechCrunch, and Ars Technica",
  },
  tone: "terse",
};

test("personaAnswer builds a prompt from only the brief and the last agent reply, not the whole transcript", async () => {
  let seenPrompt = "";
  const call = async (prompt: string) => {
    seenPrompt = prompt;
    return { text: "every weekday morning at 8am" };
  };
  const history = [
    { human: "set up my digest", agentReply: "Happy to help — what topic?" },
  ];

  await personaAnswer(brief, "What cadence works for you?", history, call);

  expect(seenPrompt).toContain("What cadence works for you?");
  expect(seenPrompt).toContain(brief.goal);
  expect(seenPrompt).toContain("every weekday morning at 8am");
  // The prior turn's agent reply text is not repeated verbatim in the
  // prompt — only the brief and the current question drive the answer.
  expect(seenPrompt).not.toContain("Happy to help");
});

test("personaAnswer returns the persona's reply text as a message", async () => {
  const call = async () => ({ text: "every weekday morning at 8am" });
  const reply = await personaAnswer(
    brief,
    "What cadence works for you?",
    [],
    call,
  );
  expect(reply).toEqual({
    kind: "message",
    text: "every weekday morning at 8am",
  });
});

test("personaAnswer maps an exact DONE response to a done reply", async () => {
  const call = async () => ({ text: "DONE" });
  const reply = await personaAnswer(
    brief,
    "Great, I'll set that up now.",
    [],
    call,
  );
  expect(reply).toEqual({ kind: "done" });
});

test("personaAnswer maps a DONE response with surrounding whitespace to a done reply", async () => {
  const call = async () => ({ text: "  DONE\n" });
  const reply = await personaAnswer(
    brief,
    "All set, running it now.",
    [],
    call,
  );
  expect(reply).toEqual({ kind: "done" });
});
