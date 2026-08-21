import { describe, expect, test } from "bun:test";
import { parseCampaignConfig } from "./config";

function validInput() {
  return {
    seed: 1,
    targetMessages: 100,
    checkpoints: [0, 50, 100],
    threadReplyRate: 0.2,
    mentionEvery: 10,
    realTurnEvery: 15,
    burstEvery: 20,
    burstSize: 3,
    simDaysPerCheckpointGap: 2,
    restartAtMessages: [60],
    providerSwitchAtMessages: [70],
    skillEditAtMessages: [40],
    spawnAgentAtMessages: [30],
  };
}

describe("parseCampaignConfig", () => {
  test("accepts a well-formed config", () => {
    const config = parseCampaignConfig(validInput());
    expect(config.targetMessages).toBe(100);
    expect(config.checkpoints).toEqual([0, 50, 100]);
  });

  test("rejects a config missing required fields", () => {
    const { seed: _seed, ...rest } = validInput();
    expect(() => parseCampaignConfig(rest)).toThrow();
  });

  test("rejects a threadReplyRate outside [0, 1]", () => {
    expect(() =>
      parseCampaignConfig({ ...validInput(), threadReplyRate: 1.5 }),
    ).toThrow();
  });

  test("rejects a negative targetMessages", () => {
    expect(() =>
      parseCampaignConfig({ ...validInput(), targetMessages: -5 }),
    ).toThrow();
  });

  test("rejects checkpoints that do not start at 0", () => {
    expect(() =>
      parseCampaignConfig({ ...validInput(), checkpoints: [10, 50] }),
    ).toThrow(/start at 0/);
  });

  test("rejects checkpoints that are not strictly ascending", () => {
    expect(() =>
      parseCampaignConfig({ ...validInput(), checkpoints: [0, 50, 50] }),
    ).toThrow(/ascending/);
  });

  test("error messages are readable, not raw arktype internals", () => {
    try {
      parseCampaignConfig({ ...validInput(), seed: "not-a-number" });
      throw new Error("expected parseCampaignConfig to throw");
    } catch (error) {
      expect(String(error)).toContain("parseCampaignConfig");
    }
  });
});
