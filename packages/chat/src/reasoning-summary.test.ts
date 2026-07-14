/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  splitReasoningSteps,
  isLowSignalReasoning,
  dedupeReasoningSteps,
  rollingReasoningLabel,
} from "./reasoning-summary";

describe("splitReasoningSteps", () => {
  it("splits on newlines and strips markdown markers", () => {
    expect(
      splitReasoningSteps("# Plan\n- First step\n\n> Second step"),
    ).toEqual(["Plan", "First step", "Second step"]);
  });

  it("drops blank lines", () => {
    expect(splitReasoningSteps("\n\nOnly line\n\n")).toEqual(["Only line"]);
  });
});

describe("isLowSignalReasoning", () => {
  it("flags tool-discovery narration", () => {
    expect(isLowSignalReasoning("Looking for tools about read file")).toBe(true);
    expect(isLowSignalReasoning("Getting that ready")).toBe(true);
    expect(isLowSignalReasoning("Bringing 4 tools online")).toBe(true);
    expect(isLowSignalReasoning("Searching skills for research")).toBe(true);
  });

  it("keeps genuine reasoning steps", () => {
    expect(
      isLowSignalReasoning("Comparing the two vendors' pricing tiers"),
    ).toBe(false);
    expect(isLowSignalReasoning("Drafting the reply to the customer")).toBe(
      false,
    );
  });
});

describe("dedupeReasoningSteps", () => {
  it("removes repeated fragments, keeping first occurrence order", () => {
    expect(
      dedupeReasoningSteps([
        "Looking for tools about read file",
        "Looking for tools about read file",
        "Drafting reply",
        "Looking for tools about read file",
      ]),
    ).toEqual(["Looking for tools about read file", "Drafting reply"]);
  });
});

describe("rollingReasoningLabel", () => {
  it("returns the latest meaningful step, skipping low-signal narration", () => {
    const text = [
      "Checking the CRM records",
      "Looking for tools about read file",
      "Bringing 4 tools online",
    ].join("\n");
    expect(rollingReasoningLabel(text)).toBe("Checking the CRM records");
  });

  it("rolls forward as new meaningful steps arrive", () => {
    expect(
      rollingReasoningLabel("First I check the CRM\nNow drafting the reply"),
    ).toBe("Now drafting the reply");
  });

  it("returns null when every step is low-signal", () => {
    expect(
      rollingReasoningLabel(
        "Looking for tools about X\nBringing 2 tools online",
      ),
    ).toBeNull();
  });

  it("returns null for empty reasoning", () => {
    expect(rollingReasoningLabel("")).toBeNull();
  });
});
