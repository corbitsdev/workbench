import { createRng, pick } from "./prng";
import { SALES_TEAM, utterance, type Persona } from "./personas";
import type { CampaignConfig } from "./config";

export type PlanStep =
  | {
      kind: "say";
      actor: string;
      text: string;
      ref?: string;
      inReplyToRef?: string;
      mentions?: readonly string[];
    }
  | { kind: "burst"; sends: readonly { actor: string; text: string }[] }
  | { kind: "realTurn"; actor: string; text: string; agent: string }
  | { kind: "routineAdvance"; simDay: number }
  | { kind: "checkpoint"; atMessages: number }
  | { kind: "restartHub"; atMessages: number }
  | { kind: "providerSwitch"; atMessages: number }
  | { kind: "skillEdit"; marker: string; atMessages: number }
  | { kind: "skillProbe"; marker: string; atMessages: number }
  | { kind: "spawnAgent"; agentKey: string; atMessages: number };

/** The agent key every fire-and-forget mention targets; the provisioned
 * cast must include an agent under this key. */
export const MENTION_AGENT_KEY = "support-copilot";
/** The agent key measured turns (`realTurn`), skill probes, and
 * provider switches target; the provisioned cast must include it. */
export const REAL_AGENT_KEY = "sales-analyst";
const THREAD_WINDOW_SIZE = 20;
const THREAD_ROOT_EVERY = 4;
const SKILL_PROBE_DELAY_MESSAGES = 20;

const EVENT_PRIORITY: Record<PlanStep["kind"], number> = {
  checkpoint: 0,
  restartHub: 1,
  providerSwitch: 2,
  skillEdit: 3,
  skillProbe: 4,
  spawnAgent: 5,
  routineAdvance: 6,
  say: 7,
  burst: 7,
  realTurn: 7,
};

function clampToTarget(atMessages: number, targetMessages: number): number {
  return Math.min(atMessages, targetMessages);
}

function buildWeightedPicker(
  personas: readonly Persona[],
): (rng: () => number) => Persona {
  const totalWeight = personas.reduce(
    (sum, persona) => sum + persona.cadenceWeight,
    0,
  );
  return (rng: () => number): Persona => {
    let remaining = rng() * totalWeight;
    for (const persona of personas) {
      remaining -= persona.cadenceWeight;
      if (remaining <= 0) return persona;
    }
    const last = personas[personas.length - 1];
    if (last === undefined) {
      throw new Error("buildWeightedPicker: personas must be non-empty");
    }
    return last;
  };
}

function routineAdvancePositions(config: CampaignConfig): number[] {
  const positions: number[] = [];
  if (config.simDaysPerCheckpointGap <= 0) return positions;
  for (let i = 0; i < config.checkpoints.length - 1; i++) {
    const start = config.checkpoints[i];
    const end = config.checkpoints[i + 1];
    if (start === undefined || end === undefined) continue;
    for (let slot = 1; slot <= config.simDaysPerCheckpointGap; slot++) {
      const fraction = slot / (config.simDaysPerCheckpointGap + 1);
      const position = Math.round(start + (end - start) * fraction);
      positions.push(clampToTarget(position, config.targetMessages));
    }
  }
  return positions;
}

function collectEvents(config: CampaignConfig): Map<number, PlanStep[]> {
  const events = new Map<number, PlanStep[]>();
  const addEvent = (atMessages: number, step: PlanStep): void => {
    const existing = events.get(atMessages) ?? [];
    existing.push(step);
    events.set(atMessages, existing);
  };

  for (const atMessages of config.checkpoints) {
    addEvent(atMessages, { kind: "checkpoint", atMessages });
  }
  for (const raw of config.restartAtMessages) {
    const atMessages = clampToTarget(raw, config.targetMessages);
    addEvent(atMessages, { kind: "restartHub", atMessages });
  }
  for (const raw of config.providerSwitchAtMessages) {
    const atMessages = clampToTarget(raw, config.targetMessages);
    addEvent(atMessages, { kind: "providerSwitch", atMessages });
  }
  config.skillEditAtMessages.forEach((raw, index) => {
    const marker = `skill-edit-${index + 1}`;
    const editAt = clampToTarget(raw, config.targetMessages);
    const probeAt = clampToTarget(
      raw + SKILL_PROBE_DELAY_MESSAGES,
      config.targetMessages,
    );
    addEvent(editAt, { kind: "skillEdit", marker, atMessages: editAt });
    addEvent(probeAt, { kind: "skillProbe", marker, atMessages: probeAt });
  });
  config.spawnAgentAtMessages.forEach((raw, index) => {
    const atMessages = clampToTarget(raw, config.targetMessages);
    addEvent(atMessages, {
      kind: "spawnAgent",
      agentKey: `spawned-agent-${index + 1}`,
      atMessages,
    });
  });
  for (const atMessages of routineAdvancePositions(config)) {
    addEvent(atMessages, { kind: "routineAdvance", simDay: 0 });
  }

  for (const [atMessages, steps] of events) {
    events.set(
      atMessages,
      [...steps].sort(
        (a, b) => EVENT_PRIORITY[a.kind] - EVENT_PRIORITY[b.kind],
      ),
    );
  }
  return events;
}

/**
 * buildPlan runs one deterministic forward pass over message slots 1..targetMessages.
 * A burst never crosses an event boundary, so every scheduled event still lands
 * exactly on its configured message count even when bursts jump several
 * messages at once.
 */
export function buildPlan(config: CampaignConfig): PlanStep[] {
  const rng = createRng(config.seed);
  const pickPersona = buildWeightedPicker(SALES_TEAM);
  const events = collectEvents(config);
  const sortedEventKeys = [...events.keys()].sort((a, b) => a - b);

  const steps: PlanStep[] = [];
  const threadWindow: string[] = [];
  let simDay = 0;
  let refCounter = 0;
  let attemptIndex = 0;

  const nextBoundaryAfter = (count: number): number => {
    for (const key of sortedEventKeys) {
      if (key > count) return key;
    }
    return config.targetMessages;
  };

  const emitEventsAt = (count: number): void => {
    const due = events.get(count);
    if (due === undefined) return;
    for (const step of due) {
      if (step.kind === "routineAdvance") {
        simDay += 1;
        steps.push({ kind: "routineAdvance", simDay });
      } else {
        steps.push(step);
      }
    }
    events.delete(count);
  };

  emitEventsAt(0);

  let messagesSoFar = 0;
  while (messagesSoFar < config.targetMessages) {
    attemptIndex += 1;
    const remaining = config.targetMessages - messagesSoFar;
    const boundary = nextBoundaryAfter(messagesSoFar);
    const roomBeforeBoundary = boundary - messagesSoFar;

    if (
      config.burstEvery > 0 &&
      config.burstSize > 0 &&
      attemptIndex % config.burstEvery === 0
    ) {
      const size = Math.max(
        1,
        Math.min(config.burstSize, remaining, roomBeforeBoundary),
      );
      const sends = Array.from({ length: size }, () => {
        const persona = pickPersona(rng);
        return { actor: persona.key, text: utterance(persona, rng, simDay) };
      });
      steps.push({ kind: "burst", sends });
      messagesSoFar += size;
    } else if (
      config.realTurnEvery > 0 &&
      attemptIndex % config.realTurnEvery === 0
    ) {
      const persona = pickPersona(rng);
      steps.push({
        kind: "realTurn",
        actor: persona.key,
        text: utterance(persona, rng, simDay),
        agent: REAL_AGENT_KEY,
      });
      messagesSoFar += 1;
    } else {
      const persona = pickPersona(rng);
      const step: PlanStep = {
        kind: "say",
        actor: persona.key,
        text: utterance(persona, rng, simDay),
      };
      if (config.mentionEvery > 0 && attemptIndex % config.mentionEvery === 0) {
        step.mentions = [MENTION_AGENT_KEY];
      }
      if (threadWindow.length > 0 && rng() < config.threadReplyRate) {
        step.inReplyToRef = pick(rng, threadWindow);
      }
      if (attemptIndex % THREAD_ROOT_EVERY === 0) {
        refCounter += 1;
        const ref = `say-${refCounter}`;
        step.ref = ref;
        threadWindow.push(ref);
        if (threadWindow.length > THREAD_WINDOW_SIZE) threadWindow.shift();
      }
      steps.push(step);
      messagesSoFar += 1;
    }

    emitEventsAt(messagesSoFar);
  }

  return steps;
}

export function summarizePlan(steps: readonly PlanStep[]): {
  says: number;
  burstSends: number;
  realTurns: number;
  checkpoints: number[];
} {
  let says = 0;
  let burstSends = 0;
  let realTurns = 0;
  const checkpoints: number[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case "say":
        says += 1;
        break;
      case "burst":
        burstSends += step.sends.length;
        break;
      case "realTurn":
        realTurns += 1;
        break;
      case "checkpoint":
        checkpoints.push(step.atMessages);
        break;
      default:
        break;
    }
  }
  return { says, burstSends, realTurns, checkpoints };
}
