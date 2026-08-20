// Plays an `EvalDefinition` against a `Target`, step by step, running
// each step's scorers against the transcript recorded so far. Pure
// orchestration — the target owns every side effect (sending a turn,
// observing tool calls); this module never talks to a hub directly,
// which is what makes it testable against a fake target with no real
// stack booted (see runner.test.ts).
import { runPersonaStep } from "./persona-runner.ts";
import type {
  EvalDefinition,
  EvalRunResult,
  EvalStepRecord,
  ScorerReport,
  Target,
  Turn,
  WorldSnapshot,
} from "./types.ts";

function emptyWorldSnapshot(): WorldSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    agentDefinitions: [],
    routines: [],
    connections: [],
    webhookTriggers: [],
    fakeReceipts: [],
  };
}

export async function runEval(
  evalDef: EvalDefinition,
  target: Target,
  personaCall?: (prompt: string) => Promise<{ text: string }>,
): Promise<EvalRunResult> {
  const startedAt = new Date().toISOString();
  const transcript: Turn[] = [];
  const steps: EvalStepRecord[] = [];

  for (const seed of evalDef.memorySeed ?? []) {
    const turn = await target.sendTurn(`Please remember: ${seed}`);
    transcript.push(turn);
  }

  for (const [stepIndex, step] of evalDef.steps.entries()) {
    const stepTurns =
      step.kind === "persona"
        ? await runPersonaStep(step, target, personaCall)
        : [await target.sendTurn(step.human)];
    const turn = stepTurns[stepTurns.length - 1];
    if (turn === undefined) {
      throw new Error(`runEval: step ${String(stepIndex)} produced no turns`);
    }
    transcript.push(...stepTurns);
    const turnIndex = transcript.length - 1;
    const world = (await target.snapshotWorld?.()) ?? emptyWorldSnapshot();
    const scorerReports: ScorerReport[] = [];
    for (const scorer of step.expect) {
      const scorerResult = await scorer({ transcript, turnIndex, world });
      scorerReports.push({ ...scorerResult, stepIndex });
    }
    steps.push({ stepIndex, turn, scorerReports });
  }

  return {
    evalName: evalDef.name,
    configName: target.configName,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
  };
}

/**
 * Runs every eval against a target built per matrix entry. `targetFor`
 * constructs and owns one `Target` per config (a live hub+sidecar
 * connection in production, a fake in tests) and is responsible for
 * `close()`ing anything it opens — `runMatrix` always closes the
 * target it received, even when a run throws, so a failed eval never
 * leaks a live connection.
 */
export async function runMatrix(
  evals: readonly EvalDefinition[],
  configs: readonly { name: string }[],
  targetFor: (configName: string) => Promise<Target>,
): Promise<EvalRunResult[]> {
  const results: EvalRunResult[] = [];
  for (const config of configs) {
    const target = await targetFor(config.name);
    try {
      for (const evalDef of evals) {
        results.push(await runEval(evalDef, target));
      }
    } finally {
      await target.close();
    }
  }
  return results;
}
