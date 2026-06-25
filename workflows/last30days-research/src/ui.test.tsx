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
});
