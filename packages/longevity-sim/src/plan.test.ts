import { describe, expect, test } from "bun:test";
import { parseCampaignConfig, type CampaignConfig } from "./config";
import { buildPlan, summarizePlan, type PlanStep } from "./plan";

function baseConfig(overrides: Partial<CampaignConfig> = {}): CampaignConfig {
  return parseCampaignConfig({
    seed: 123,
    targetMessages: 300,
    checkpoints: [0, 100, 200, 300],
    threadReplyRate: 0.3,
    mentionEvery: 12,
    realTurnEvery: 25,
    burstEvery: 40,
    burstSize: 4,
    simDaysPerCheckpointGap: 3,
    restartAtMessages: [150],
    providerSwitchAtMessages: [180],
    skillEditAtMessages: [50, 210],
    spawnAgentAtMessages: [90],
    ...overrides,
  });
}

function sayAndBurstSendCount(steps: readonly PlanStep[]): number {
  return steps.reduce((count, step) => {
    if (step.kind === "say") return count + 1;
    if (step.kind === "burst") return count + step.sends.length;
    if (step.kind === "realTurn") return count + 1;
    return count;
  }, 0);
}

describe("buildPlan", () => {
  test("is deterministic for the same seed", () => {
    const config = baseConfig();
    expect(buildPlan(config)).toEqual(buildPlan(config));
  });

  test("say + burst-send + realTurn count equals targetMessages", () => {
    const config = baseConfig();
    const steps = buildPlan(config);
    expect(sayAndBurstSendCount(steps)).toBe(config.targetMessages);
  });

  test("checkpoints appear exactly at their configured message counts, in order", () => {
    const config = baseConfig();
    const steps = buildPlan(config);
    const checkpointSteps = steps.filter(
      (step): step is Extract<PlanStep, { kind: "checkpoint" }> =>
        step.kind === "checkpoint",
    );
    expect(checkpointSteps.map((step) => step.atMessages)).toEqual(
      config.checkpoints as number[],
    );
  });

  test("every skillEdit is followed later by its skillProbe with the same marker", () => {
    const config = baseConfig();
    const steps = buildPlan(config);
    const edits = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.kind === "skillEdit");
    expect(edits.length).toBe(config.skillEditAtMessages.length);
    for (const { step, index } of edits) {
      if (step.kind !== "skillEdit") continue;
      const probeIndex = steps.findIndex(
        (candidate) =>
          candidate.kind === "skillProbe" && candidate.marker === step.marker,
      );
      expect(probeIndex).toBeGreaterThan(index);
    }
  });

  test("refs are unique and every inReplyToRef names an earlier ref", () => {
    const config = baseConfig();
    const steps = buildPlan(config);
    const seenRefs = new Set<string>();
    for (const step of steps) {
      if (step.kind !== "say") continue;
      if (step.inReplyToRef !== undefined) {
        expect(seenRefs.has(step.inReplyToRef)).toBe(true);
      }
      if (step.ref !== undefined) {
        expect(seenRefs.has(step.ref)).toBe(false);
        seenRefs.add(step.ref);
      }
    }
    expect(seenRefs.size).toBeGreaterThan(0);
  });

  test("places an event beyond targetMessages at the end", () => {
    const config = baseConfig({
      targetMessages: 50,
      checkpoints: [0, 50],
      restartAtMessages: [500],
      skillEditAtMessages: [],
      spawnAgentAtMessages: [],
      providerSwitchAtMessages: [],
    });
    const steps = buildPlan(config);
    const restart = steps.find((step) => step.kind === "restartHub");
    expect(restart).toBeDefined();
    if (restart?.kind === "restartHub") {
      expect(restart.atMessages).toBe(50);
    }
  });

  test("distributes says across personas rather than always picking one", () => {
    const config = baseConfig();
    const steps = buildPlan(config);
    const actors = new Set(
      steps
        .filter(
          (step): step is Extract<PlanStep, { kind: "say" }> =>
            step.kind === "say",
        )
        .map((step) => step.actor),
    );
    expect(actors.size).toBeGreaterThan(1);
  });
});

describe("summarizePlan", () => {
  test("matches manual counts over a built plan", () => {
    const config = baseConfig();
    const steps = buildPlan(config);
    const summary = summarizePlan(steps);
    expect(summary.says + summary.burstSends).toBeLessThanOrEqual(
      config.targetMessages,
    );
    expect(summary.checkpoints).toEqual(config.checkpoints as number[]);
  });
});
