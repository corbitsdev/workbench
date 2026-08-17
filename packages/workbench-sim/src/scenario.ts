// The scenario DSL: plain TS objects describing a scripted stretch of
// team life — humans posting, thread replies, routine fires, quiet
// gaps — with virtual-time labels so a "week" plays out in seconds.
// Pure data + pure summarizers; only the runner ever touches a stack.

export type LabelStep = { kind: "label"; at: string };

export type HumanSayStep = {
  kind: "humanSay";
  /** Actor key into `Scenario.humans`. */
  actor: string;
  text: string;
  /** Names this message so later steps can thread-reply to it. */
  ref?: string;
  /** Ref of an earlier `humanSay` this message replies to. */
  inReplyToRef?: string;
  /** Agent handles to @-mention; the runner resolves the live handle. */
  mentions?: readonly string[];
};

export type RoutineFireStep = { kind: "routineFire"; routine: string };

export type WaitQuietStep = { kind: "waitQuiet"; ms: number };

export type Step = LabelStep | HumanSayStep | RoutineFireStep | WaitQuietStep;

export interface AgentSpec {
  /** Stable key steps use in `mentions`. */
  key: string;
  /** Which shipped workflow definition backs this agent. */
  workflow: "echo";
}

export interface RoutineSpec {
  /** Stable key `routineFire` steps use. */
  key: string;
  name: string;
  /** Which shipped workflow definition the routine launches. */
  workflow: "heartbeat";
}

export interface Scenario {
  name: string;
  description: string;
  /** Actor key -> display name. First entry owns the workbench. */
  humans: Readonly<Record<string, string>>;
  agents: readonly AgentSpec[];
  routines: readonly RoutineSpec[];
  steps: readonly Step[];
}

export const label = (at: string): LabelStep => ({ kind: "label", at });

export const humanSay = (
  actor: string,
  text: string,
  extra: Omit<HumanSayStep, "kind" | "actor" | "text"> = {},
): HumanSayStep => ({ kind: "humanSay", actor, text, ...extra });

export const routineFire = (routine: string): RoutineFireStep => ({
  kind: "routineFire",
  routine,
});

export const waitQuiet = (ms: number): WaitQuietStep => ({
  kind: "waitQuiet",
  ms,
});

export interface ScenarioShape {
  messages: number;
  threadReplies: number;
  routineFires: number;
  labels: readonly string[];
}

/** Pure census of a scenario's steps, so a scenario's own volume
 * claims ("100+ messages, 20 replies, 10 fires") are testable without
 * booting anything. */
export function summarizeScenario(scenario: Scenario): ScenarioShape {
  let messages = 0;
  let threadReplies = 0;
  let routineFires = 0;
  const labels: string[] = [];
  for (const step of scenario.steps) {
    switch (step.kind) {
      case "humanSay":
        messages += 1;
        if (step.inReplyToRef !== undefined) threadReplies += 1;
        break;
      case "routineFire":
        routineFires += 1;
        break;
      case "label":
        labels.push(step.at);
        break;
      case "waitQuiet":
        break;
    }
  }
  return { messages, threadReplies, routineFires, labels };
}

/** Refs must be unique and every `inReplyToRef` must name an earlier
 * ref; actors, agents, and routines must exist. Returns human-readable
 * problems (empty = valid). */
export function validateScenario(scenario: Scenario): string[] {
  const problems: string[] = [];
  const seenRefs = new Set<string>();
  const agentKeys = new Set(scenario.agents.map((agent) => agent.key));
  const routineKeys = new Set(scenario.routines.map((r) => r.key));
  for (const [index, step] of scenario.steps.entries()) {
    if (step.kind === "humanSay") {
      if (!(step.actor in scenario.humans)) {
        problems.push(`step ${index}: unknown actor "${step.actor}"`);
      }
      if (step.inReplyToRef !== undefined && !seenRefs.has(step.inReplyToRef)) {
        problems.push(
          `step ${index}: inReplyToRef "${step.inReplyToRef}" names no earlier ref`,
        );
      }
      for (const mention of step.mentions ?? []) {
        if (!agentKeys.has(mention)) {
          problems.push(`step ${index}: unknown mention "${mention}"`);
        }
      }
      if (step.ref !== undefined) {
        if (seenRefs.has(step.ref)) {
          problems.push(`step ${index}: duplicate ref "${step.ref}"`);
        }
        seenRefs.add(step.ref);
      }
    }
    if (step.kind === "routineFire" && !routineKeys.has(step.routine)) {
      problems.push(`step ${index}: unknown routine "${step.routine}"`);
    }
  }
  return problems;
}
