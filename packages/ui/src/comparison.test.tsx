/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  ComparisonView,
  parseComparisonResult,
  type ComparisonResult,
} from "./comparison";

afterEach(cleanup);

const RESULT: ComparisonResult = {
  summary: "Variant 1 is the sharpest of the three.",
  recommendation: "Ship Variant 1; borrow the closing line from Variant 2.",
  decidedBy: "agent",
  ranking: [
    { rank: 1, label: "Variant 1", rationale: "Tightest hook." },
    { rank: 2, label: "Variant 2", rationale: "Strong but verbose." },
  ],
  variants: [
    {
      label: "Variant 1",
      providerName: "anthropic",
      model: "claude",
      content: "First variant body text.",
    },
    {
      label: "Variant 2",
      providerName: "openai",
      model: "gpt",
      content: "Second variant body text.",
    },
  ],
};

describe("parseComparisonResult", () => {
  it("parses a JSON string payload", () => {
    const parsed = parseComparisonResult(JSON.stringify(RESULT));
    expect(parsed?.ranking).toHaveLength(2);
    expect(parsed?.variants[0]?.content).toBe("First variant body text.");
  });

  it("parses an already-decoded object", () => {
    expect(parseComparisonResult(RESULT)?.summary).toBe(RESULT.summary);
  });

  it("returns null for a non-JSON string", () => {
    expect(parseComparisonResult("{not json")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    // ranking + variants are required; a bare summary must not validate.
    expect(parseComparisonResult({ summary: "hi" })).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(parseComparisonResult(null)).toBeNull();
    expect(parseComparisonResult(undefined)).toBeNull();
  });
});

describe("ComparisonView", () => {
  it("renders the summary, recommendation, rationale, and variant content", () => {
    render(<ComparisonView result={RESULT} />);
    expect(screen.getByText(RESULT.summary as string)).toBeDefined();
    expect(screen.getByText(RESULT.recommendation as string)).toBeDefined();
    expect(screen.getByText("Tightest hook.")).toBeDefined();
    expect(screen.getByText("First variant body text.")).toBeDefined();
    expect(screen.getByText("Second variant body text.")).toBeDefined();
  });

  it("accents only the rank-1 entry, not the runner-up", () => {
    render(<ComparisonView result={RESULT} />);
    // "Variant N" appears in both the ranking list and the variant card; scope
    // to the ranking <li> to assert the winner accent there.
    const liFor = (label: string) =>
      screen
        .getAllByText(label)
        .map((el) => el.closest("li"))
        .find((li): li is HTMLLIElement => li !== null);
    expect(liFor("Variant 1")?.className).toContain("border-orange");
    expect(liFor("Variant 2")?.className).not.toContain("border-orange");
  });

  it("renders provider · model metadata for each variant when revealed", () => {
    render(<ComparisonView result={RESULT} />);
    expect(screen.getByText("anthropic · claude")).toBeDefined();
    expect(screen.getByText("openai · gpt")).toBeDefined();
  });

  it("hides provider/model when blind, but still shows variant content", () => {
    render(<ComparisonView result={RESULT} blind />);
    expect(screen.queryByText("anthropic · claude")).toBeNull();
    expect(screen.queryByText("openai · gpt")).toBeNull();
    // Content and labels stay visible; only the identity is hidden.
    expect(screen.getByText("First variant body text.")).toBeDefined();
  });

  it("omits the variants section when no variant carries content", () => {
    const rankingOnly: ComparisonResult = {
      ...RESULT,
      variants: [],
    };
    render(<ComparisonView result={rankingOnly} />);
    // Ranking still renders; the Variants heading does not.
    expect(screen.getByText("Ranking")).toBeDefined();
    expect(screen.queryByText("Variants")).toBeNull();
  });
});
