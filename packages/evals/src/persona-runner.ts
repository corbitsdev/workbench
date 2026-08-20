// Plays a `PersonaEvalStep`'s human side turn-by-turn against a
// `Target`, generating each follow-up message from `personaAnswer`
// instead of a scripted string. Termination is triple-guarded so the
// loop never runs unbounded: (a) `maxTurns` is a hard cap; (b) the
// agent's reply carrying no "?" is a structural "stopped asking"
// signal that needs no model call — the same heuristic
// `asksQuestions` (scorers/scorers.ts) already codifies; (c) the
// persona itself may decide it has nothing left to volunteer.

import { personaAnswer } from "./persona.ts";
import type { PersonaEvalStep, Target, Turn } from "./types.ts";

function stillAsking(replyText: string): boolean {
  return (replyText.match(/\?/g) ?? []).length > 0;
}

export async function runPersonaStep(
  step: PersonaEvalStep,
  target: Target,
  call?: (prompt: string) => Promise<{ text: string }>,
): Promise<Turn[]> {
  const turns: Turn[] = [];
  const history: { human: string; agentReply: string }[] = [];
  let human = step.opening;

  for (let i = 0; i < step.maxTurns; i += 1) {
    const turn = await target.sendTurn(human);
    turns.push(turn);
    history.push({ human, agentReply: turn.replyText });

    if (!stillAsking(turn.replyText)) {
      break;
    }
    const reply = await personaAnswer(
      step.persona,
      turn.replyText,
      history,
      call,
    );
    if (reply.kind === "done") {
      break;
    }
    human = reply.text;
  }

  return turns;
}
