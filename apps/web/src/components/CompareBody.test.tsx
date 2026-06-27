/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import CompareBody from "./CompareBody";
import type { ComparisonResult } from "@workbench/ui";

afterEach(() => {
  cleanup();
});

const FIXTURE: ComparisonResult = {
  summary: "Variant B is the stronger opener for this audience.",
  recommendation: "Ship Variant B and A/B test the subject line.",
  decidedBy: "agent",
  ranking: [
    {
      rank: 1,
      label: "Variant B",
      rationale: "Leads with the customer pain and a concrete metric.",
    },
    { rank: 2, label: "Variant A", rationale: "Generic value prop opener." },
  ],
  variants: [
    { label: "Variant A", providerName: "openai", content: "Hello there A." },
    {
      label: "Variant B",
      providerName: "anthropic",
      content: "Hello there B with a sharper hook.",
    },
  ],
};

describe("CompareBody", () => {
  it("renders the ranking rationale and variant content for a valid payload", () => {
    render(
      React.createElement(CompareBody, { content: JSON.stringify(FIXTURE) }),
    );
    screen.getByText("Variant B is the stronger opener for this audience.");
    screen.getByText("Leads with the customer pain and a concrete metric.");
    screen.getByText(/Hello there B with a sharper hook/);
    screen.getByText("Ship Variant B and A/B test the subject line.");
  });

  it("falls back to raw markdown without crashing for a malformed payload", () => {
    render(
      React.createElement(CompareBody, {
        content: "not json { broken",
      }),
    );
    screen.getByText(/not json/);
    // The branded comparison view never rendered, so its section headings are absent.
    if (screen.queryByText("Ranking") !== null) {
      throw new Error("Malformed payload must not render the comparison view");
    }
  });
});
