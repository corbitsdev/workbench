/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  deriveActivityLabel,
  isLowSignalReasoning,
  toSingleLine,
} from "./activity-label";
import type { Part } from "./types";

describe("toSingleLine", () => {
  it("collapses whitespace runs to a single space and trims", () => {
    expect(toSingleLine("  a\n\n  b   c \t")).toBe("a b c");
  });
});

describe("isLowSignalReasoning", () => {
  it("flags tool-discovery narration", () => {
    expect(isLowSignalReasoning("Looking for tools about read file")).toBe(
      true,
    );
    expect(isLowSignalReasoning("Bringing 4 tools online")).toBe(true);
    expect(isLowSignalReasoning("Getting that ready")).toBe(true);
    expect(isLowSignalReasoning("Searching skills for research")).toBe(true);
  });

  it("keeps genuine reasoning steps", () => {
    expect(
      isLowSignalReasoning("Comparing the two vendors' pricing tiers"),
    ).toBe(false);
  });
});

describe("deriveActivityLabel", () => {
  it("returns the trailing reasoning part's latest meaningful line", () => {
    const parts: Part[] = [
      {
        type: "reasoning",
        text: "Checking the CRM records\nLooking for tools about read file\nBringing 4 tools online",
      },
    ];
    expect(deriveActivityLabel(parts)).toBe("Checking the CRM records");
  });

  it("returns a formatted label for a trailing tool part", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "Deciding what to search" },
      {
        type: "tool",
        toolCallId: "c1",
        toolName: "attio__query_records",
        state: "pending",
      },
    ];
    expect(deriveActivityLabel(parts, () => "Searching Attio")).toBe(
      "Searching Attio",
    );
  });

  it("skips a trailing text part and reports the last real activity behind it", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "Drafting the summary" },
      { type: "text", text: "Here is the answer so far" },
    ];
    expect(deriveActivityLabel(parts)).toBe("Drafting the summary");
  });

  it("falls back to a tool's human-authored label with no formatter", () => {
    const parts: Part[] = [
      {
        type: "tool",
        toolCallId: "c1",
        toolName: "exa__search",
        state: "output-available",
        output: "[]",
        label: "Searching the web",
      },
    ];
    expect(deriveActivityLabel(parts)).toBe("Searching the web");
  });

  it("never surfaces a raw internal tool name — walks past an unlabeled tool part", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "Checking the account" },
      {
        type: "tool",
        toolCallId: "c1",
        toolName: "attio__query_records",
        state: "pending",
      },
    ];
    expect(deriveActivityLabel(parts)).toBe("Checking the account");
  });

  it("falls back to 'Working' when the only activity is an unlabeled tool part", () => {
    const parts: Part[] = [
      {
        type: "tool",
        toolCallId: "c1",
        toolName: "write_file",
        state: "pending",
      },
    ];
    expect(deriveActivityLabel(parts)).toBe("Working");
  });

  it("dedupes repeated reasoning lines so a re-emitted earlier step does not roll the label backward", () => {
    const parts: Part[] = [
      {
        type: "reasoning",
        text: "Checking the CRM\nDrafting the reply\nChecking the CRM",
      },
    ];
    expect(deriveActivityLabel(parts)).toBe("Drafting the reply");
  });

  it("returns 'Working' when there is no activity part at all", () => {
    expect(deriveActivityLabel([{ type: "text", text: "hi" }])).toBe("Working");
    expect(deriveActivityLabel([])).toBe("Working");
  });

  it("returns 'Working' when reasoning is entirely low-signal narration", () => {
    const parts: Part[] = [
      {
        type: "reasoning",
        text: "Looking for tools about X\nBringing 2 tools online",
      },
    ];
    expect(deriveActivityLabel(parts)).toBe("Working");
  });
});
