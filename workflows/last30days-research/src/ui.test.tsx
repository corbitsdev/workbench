import { describe, expect, test } from "bun:test";
import type { RunState } from "@intx/workflow";
import { render, screen } from "@testing-library/react";
import { Panel } from "./ui";

const baseProps = {
  deploymentId: "run-1",
  state: null,
  connected: true,
  stepOutputs: {},
  signalPending: false,
  onSignal: () => {},
  onClose: () => {},
};

describe("last30days Panel", () => {
  test("shows intake form when intake awaits signal", () => {
    const steps = new Map([
      [
        "intake",
        {
          phase: "awaiting-signal" as const,
          output: undefined,
        },
      ],
    ]);
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "running",
            steps,
          } as unknown as RunState
        }
      />,
    );
    expect(
      screen.getByRole("button", { name: /start research/i }),
    ).toBeDefined();
    expect(screen.getByPlaceholderText(/ai coding agents/i)).toBeDefined();
  });

  test("shows synthesis and citations when run completes", () => {
    const generatedAt = "2026-03-23T12:00:00.000Z";
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "completed",
            steps: new Map([
              ["intake", { phase: "completed" }],
              ["hackernews", { phase: "completed" }],
              ["brief", { phase: "completed" }],
              ["write", { phase: "completed" }],
              ["persist", { phase: "completed" }],
            ]),
          } as unknown as RunState
        }
        stepOutputs={{
          write: { reply: "Signal is strong across sources." },
          brief: {
            content: JSON.stringify({
              topic: "GTM agents",
              days: 30,
              stats: { sourceCount: 1, itemCount: 1 },
              clusters: [],
              bestTakes: [],
              items: [],
              citations: [
                {
                  url: "https://news.ycombinator.com/item?id=1",
                  source: "hn",
                  retrievedAt: generatedAt,
                  title: "HN thread",
                },
              ],
              generatedAt,
            }),
          },
          persist: {
            content: JSON.stringify({
              title: "GTM agents",
              artifactId: "art_1",
              kind: "research",
            }),
          },
        }}
      />,
    );
    expect(screen.getByText(/Saved to workbench/)).toBeDefined();
    expect(screen.getByRole("link", { name: /HN thread/i })).toBeDefined();
  });

  // --- W2/W4 report polish + live progress (CL-2411) ---

  test("first load shows 'Setting up workflow' rather than 'Working'", () => {
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "running",
            steps: new Map([["intake", { phase: "in-flight" as const }]]),
          } as unknown as RunState
        }
      />,
    );
    expect(screen.getByText(/setting up workflow/i)).toBeDefined();
    expect(screen.queryByText(/^Working/)).toBeNull();
  });

  test("intake copy no longer mentions the disabled Bluesky source", () => {
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "running",
            steps: new Map([["intake", { phase: "awaiting-signal" as const }]]),
          } as unknown as RunState
        }
      />,
    );
    expect(screen.queryByText(/bluesky/i)).toBeNull();
  });

  test("research phase shows per-source progress including a skipped source", () => {
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "running",
            steps: new Map([
              ["intake", { phase: "completed" as const }],
              ["hackernews", { phase: "completed" as const }],
              ["github", { phase: "in-flight" as const }],
              ["reddit", { phase: "failed" as const }],
            ]),
          } as unknown as RunState
        }
      />,
    );
    expect(screen.getByText("Hacker News")).toBeDefined();
    expect(screen.getByText("Reddit")).toBeDefined();
    expect(screen.getByText("skipped")).toBeDefined();
    expect(screen.getByText("running")).toBeDefined();
  });

  test("completed report does not nest the synthesis card inside another bordered card", () => {
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "completed",
            steps: new Map([
              ["intake", { phase: "completed" }],
              ["brief", { phase: "completed" }],
              ["write", { phase: "completed" }],
              ["persist", { phase: "completed" }],
            ]),
          } as unknown as RunState
        }
        stepOutputs={{
          write: { reply: "Signal is strong across sources." },
          persist: {
            content: JSON.stringify({ title: "GTM agents", kind: "research" }),
          },
        }}
      />,
    );
    const synthesisCard = screen
      .getByText("Synthesis")
      .closest(".rounded-panel");
    expect(synthesisCard).not.toBeNull();
    expect(
      synthesisCard?.parentElement?.closest(".rounded-panel") ?? null,
    ).toBeNull();
  });
});
