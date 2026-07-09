/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import {
  ComparisonView,
  parseComparisonResult,
  type ComparisonResult,
} from "./comparison";

// framer-motion is not compatible with Happy DOM; replace motion.* with plain
// elements (stripping animation-only props) and drive useReducedMotion from a
// mutable flag so the reduced-motion path can be exercised deterministically.
let reducedMotion = false;
const MOTION_ONLY = new Set([
  "initial",
  "animate",
  "exit",
  "transition",
  "variants",
  "whileHover",
  "whileTap",
  "layout",
]);
mock.module("framer-motion", () => ({
  motion: new Proxy(
    {},
    {
      get(_t, tag: string) {
        return ({
          children,
          ...rest
        }: {
          children?: React.ReactNode;
          [key: string]: unknown;
        }) => {
          const domProps: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(rest)) {
            if (!MOTION_ONLY.has(key)) domProps[key] = value;
          }
          return React.createElement(tag, domProps, children);
        };
      },
    },
  ),
  AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useReducedMotion: () => reducedMotion,
}));

afterEach(() => {
  cleanup();
  reducedMotion = false;
});

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

// A streaming/final comparison payload: per-variant `status` drives the calm
// placeholder, the gold no-response marker, and the survivor pill.
const STREAMING: ComparisonResult = {
  ranking: [],
  variants: [
    { label: "Variant 1", content: "First body text.", status: "responded" },
    { label: "Variant 2", content: "", status: "streaming" },
    { label: "Variant 3", content: "", status: "no-response" },
  ],
};

function variantCell(label: string): HTMLElement | undefined {
  return screen
    .getAllByTestId("comparison-variant")
    .find((el) => el.getAttribute("data-label") === label);
}

describe("ComparisonView streaming states", () => {
  it("renders a calm streaming cell that keeps its slot", () => {
    render(<ComparisonView result={STREAMING} status="running" blind />);
    const cell = variantCell("Variant 2");
    expect(cell).toBeDefined();
    expect(cell?.getAttribute("data-status")).toBe("streaming");
    // The slot is present with its label even though it has no content yet.
    expect(cell?.textContent).toContain("Variant 2");
  });

  it("renders a gold No response marker that stays in the grid", () => {
    render(<ComparisonView result={STREAMING} status="running" blind />);
    const cell = variantCell("Variant 3");
    expect(cell).toBeDefined();
    expect(cell?.getAttribute("data-status")).toBe("no-response");
    expect(screen.getByText("No response")).toBeDefined();
  });

  it("shows an N of M responded pill and never a raw failure count", () => {
    render(<ComparisonView result={STREAMING} status="running" blind />);
    expect(screen.getByText("1 of 3 responded")).toBeDefined();
    // House rule: the survivor count is the only count; failures are never
    // surfaced as an alarming "2 failed" / "did not respond" tally.
    expect(screen.queryByText(/failed/i)).toBeNull();
    expect(screen.queryByText(/did not respond/i)).toBeNull();
  });

  it("suppresses the winner accent and ordinal while status is running", () => {
    const ranked: ComparisonResult = {
      ranking: [{ rank: 1, label: "Variant 1" }],
      variants: [
        { label: "Variant 1", content: "a", status: "responded" },
        { label: "Variant 2", content: "b", status: "responded" },
      ],
    };
    const { rerender } = render(
      <ComparisonView result={ranked} status="running" blind />,
    );
    expect(variantCell("Variant 1")?.getAttribute("data-winner")).toBe("false");

    // Sanity: the same ranking DOES accent the winner once the run is final.
    rerender(<ComparisonView result={ranked} status="final" blind />);
    expect(variantCell("Variant 1")?.getAttribute("data-winner")).toBe("true");
  });

  it("renders without motion wrappers under reduced motion", () => {
    reducedMotion = true;
    const { container } = render(
      <ComparisonView result={STREAMING} status="running" blind />,
    );
    // No entrance-animated wrapper is emitted; every cell renders plain.
    expect(container.querySelectorAll("[data-animated]")).toHaveLength(0);
    expect(screen.getByText("First body text.")).toBeDefined();
    expect(screen.getAllByTestId("comparison-variant")).toHaveLength(3);
  });

  it("emits animated wrappers when motion is enabled", () => {
    reducedMotion = false;
    const { container } = render(
      <ComparisonView result={STREAMING} status="running" blind />,
    );
    expect(
      container.querySelectorAll("[data-animated]").length,
    ).toBeGreaterThan(0);
  });

  it("renders a variant's humanized meta when present", () => {
    const withMeta: ComparisonResult = {
      ranking: [],
      variants: [
        {
          label: "Variant 1",
          content: "body",
          status: "responded",
          meta: "Claude Opus",
        },
      ],
    };
    render(<ComparisonView result={withMeta} status="final" />);
    expect(screen.getByText("Claude Opus")).toBeDefined();
  });
});
