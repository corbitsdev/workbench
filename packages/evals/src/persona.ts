// A simulated human that answers what's asked and volunteers nothing
// else. `personaAnswer` turns the agent's latest reply into the
// persona's next message (or a signal that the persona has nothing
// left to say) by asking a model to play the persona against its brief
// — the same injectable-call seam `judge()` uses (scorers/scorers.ts),
// so tests never need a real model.

import { callEvalModel } from "./model-call.ts";
import type { PersonaBrief } from "./types.ts";

export type PersonaReply =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "done" };

interface HistoryEntry {
  readonly human: string;
  readonly agentReply: string;
}

function buildPrompt(
  brief: PersonaBrief,
  agentReplyText: string,
  historySoFar: readonly HistoryEntry[],
): string {
  const facts = Object.entries(brief.knownFacts)
    .map(([topic, value]) => `- ${topic}: ${value}`)
    .join("\n");
  const toneLine = brief.tone === undefined ? "" : `\nTone: ${brief.tone}`;
  return [
    `You are playing ${brief.name} in a conversation with an assistant.`,
    `Your private goal: ${brief.goal}`,
    `Facts you know but only share if directly asked:\n${facts}`,
    toneLine,
    `Turns so far: ${String(historySoFar.length)}.`,
    "",
    "Rules: answer only what the assistant's last message actually asks.",
    "Never volunteer a fact the assistant did not ask about. Never restate",
    "your goal unless the assistant asks for it directly.",
    "",
    `Assistant's last message:\n${agentReplyText}`,
    "",
    "If the assistant is no longer asking anything — it is confirming or",
    'executing — reply with exactly one line: "DONE". Otherwise reply with',
    "exactly one line: your next message to the assistant, nothing else.",
  ].join("\n");
}

export function personaAnswer(
  brief: PersonaBrief,
  agentReplyText: string,
  historySoFar: readonly HistoryEntry[],
  call?: (prompt: string) => Promise<{ text: string }>,
): Promise<PersonaReply> {
  const prompt = buildPrompt(brief, agentReplyText, historySoFar);
  const run = call ?? defaultCall;
  return run(prompt).then((response) => {
    const text = response.text.trim();
    if (text === "DONE") {
      return { kind: "done" };
    }
    return { kind: "message", text };
  });
}

async function defaultCall(prompt: string): Promise<{ text: string }> {
  const key = process.env["EVAL_PROVIDER_API_KEY"];
  if (key === undefined || key === "") {
    throw new Error(
      "personaAnswer: EVAL_PROVIDER_API_KEY not set and no call() was injected",
    );
  }
  return callEvalModel(prompt, key);
}
