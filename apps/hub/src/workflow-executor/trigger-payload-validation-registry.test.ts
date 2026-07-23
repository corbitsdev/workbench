import { describe, expect, it } from "bun:test";
import { validateTriggerPayloadForStart } from "./trigger-payload-validation-registry";

describe("validateTriggerPayloadForStart", () => {
  it("passes a kind with no registered validator regardless of input", () => {
    const result = validateTriggerPayloadForStart("some-other-kind", {});
    expect(result.ok).toBe(true);
  });

  it("passes prospect-engine with both Engine list ids and no Slack channel", () => {
    const result = validateTriggerPayloadForStart("prospect-engine", {
      growthEngineListId: 1,
      enterpriseEngineListId: 2,
    });
    expect(result.ok).toBe(true);
  });

  it("fails prospect-engine missing a genuinely required list id, without mentioning Slack", () => {
    const result = validateTriggerPayloadForStart("prospect-engine", {
      slackChannelId: "C1",
      growthEngineListId: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid_input");
    expect(result.message).toContain("Engine - Enterprise Sumble list id");
    expect(result.message).not.toContain("Slack");
    expect(result.message).toContain("starting the run");
  });
});
