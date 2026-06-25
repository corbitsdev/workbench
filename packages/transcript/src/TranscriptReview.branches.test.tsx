/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { TranscriptReview } from "./TranscriptReview";
import type { StructuredTranscript } from "./types";

afterEach(cleanup);

mock.module("framer-motion", () => ({
  motion: {
    div: ({
      children,
      className,
    }: {
      children: React.ReactNode;
      className?: string;
    }) => React.createElement("div", { className }, children),
  },
}));

const base: StructuredTranscript = {
  metadata: { source: "paste" },
  speakers: [{ id: "s1", name: "Dana", role: "rep" }],
  turns: [{ id: "t1", speakerId: "s1", text: "Hello there." }],
};

describe("TranscriptReview header fallbacks", () => {
  it("falls back to companyName when no title is set", () => {
    const t: StructuredTranscript = {
      ...base,
      metadata: { source: "paste", companyName: "Acme" },
    };
    render(React.createElement(TranscriptReview, { transcript: t }));
    expect(screen.getByText("Acme")).toBeDefined();
    expect(screen.getByText(/The original call stays visible/)).toBeDefined();
  });

  it("falls back to the default heading when neither title nor companyName is set", () => {
    render(React.createElement(TranscriptReview, { transcript: base }));
    expect(screen.getByText("Source context")).toBeDefined();
  });

  it("shows companyName as a subtitle only when both title and companyName exist", () => {
    const t: StructuredTranscript = {
      ...base,
      metadata: { source: "paste", companyName: "Acme", title: "Discovery" },
    };
    render(React.createElement(TranscriptReview, { transcript: t }));
    expect(screen.getByText("Discovery")).toBeDefined();
    expect(screen.getByText("Acme")).toBeDefined();
  });
});

describe("TranscriptReview turn rendering branches", () => {
  it("labels a turn with the generic speaker name when the speakerId is unknown", () => {
    const t: StructuredTranscript = {
      ...base,
      turns: [{ id: "t1", speakerId: "ghost", text: "Orphaned turn." }],
    };
    render(React.createElement(TranscriptReview, { transcript: t }));
    expect(screen.getByText("Orphaned turn.")).toBeDefined();
    expect(screen.getByText("Speaker")).toBeDefined();
  });

  it("renders a formatted timestamp padding seconds to two digits", () => {
    const t: StructuredTranscript = {
      ...base,
      turns: [
        { id: "t1", speakerId: "s1", text: "Timed turn.", startSeconds: 65 },
      ],
    };
    render(React.createElement(TranscriptReview, { transcript: t }));
    expect(screen.getByText("1:05")).toBeDefined();
  });

  it("clamps negative offsets to 0:00", () => {
    const t: StructuredTranscript = {
      ...base,
      turns: [
        {
          id: "t1",
          speakerId: "s1",
          text: "Negative turn.",
          startSeconds: -10,
        },
      ],
    };
    render(React.createElement(TranscriptReview, { transcript: t }));
    expect(screen.getByText("0:00")).toBeDefined();
  });

  it("renders a disabled, non-interactive turn button when onSelectTurn is omitted", () => {
    render(React.createElement(TranscriptReview, { transcript: base }));
    const button = screen.getByText("Hello there.").closest("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(button?.className).toContain("cursor-default");
  });

  it("ignores blank pain-point quotes so no turn is highlighted", () => {
    render(
      React.createElement(TranscriptReview, {
        transcript: base,
        selectedPainPoints: [
          { id: "p1", severity: "low", context: "x", quote: "   " },
        ],
      }),
    );
    const button = screen.getByText("Hello there.").closest("button");
    expect(button?.className).not.toContain("ring-orange");
  });
});
