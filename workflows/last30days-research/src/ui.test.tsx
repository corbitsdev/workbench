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
    screen.getByText(/Saved to workbench/);
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
    screen.getByText(/setting up workflow/i);
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

  test("the Tailoring queries row stays running while groundQueries parses (no dead zone)", () => {
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "running",
            steps: new Map([
              ["intake", { phase: "completed" as const }],
              ["ground", { phase: "completed" as const }],
              ["groundQueries", { phase: "in-flight" as const }],
            ]),
          } as unknown as RunState
        }
      />,
    );
    // ground is done but groundQueries is parsing — the row must read "running",
    // not show every row idle. Guards the rowPhase fold of ground + groundQueries.
    screen.getByText("Tailoring queries");
    screen.getByText("running");
    expect(screen.queryByText("done")).toBeNull();
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
    screen.getByText("Hacker News");
    screen.getByText("Reddit");
    screen.getByText("skipped");
    screen.getByText("running");
    // A completed source must use the defined `text-green` success token, not
    // the undefined `text-success` (which renders as no color at all).
    const done = screen.getByText("done");
    expect(done.className).toContain("text-green");
    expect(done.className).not.toContain("text-success");
  });

  // --- CL-2505: never regress to the intake screen mid-run + live progress ---

  test("research in progress shows source progress even when the intake gate output is absent from state", () => {
    // The intake awaitSignal gate's StepCompleted can be missing from the
    // synthesized record (projection lag / unresolved ref). The panel must still
    // detect we are past intake from downstream progress and NOT fall back to the
    // "Setting up workflow" intake screen.
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "running",
            steps: new Map([
              ["hackernews", { phase: "completed" as const }],
              ["github", { phase: "in-flight" as const }],
            ]),
          } as unknown as RunState
        }
      />,
    );
    screen.getByText("Research progress");
    expect(screen.queryByText(/setting up workflow/i)).toBeNull();
  });

  test("migrated shared routing does not rewind to the intake screen when the gate output is absent but a research step has progressed (CL-2506)", () => {
    // After migrating to the shared activeDisplayStep router, the old
    // intakeIsDone rewind fix must still hold: with intake's StepCompleted
    // missing but `github` in-flight, the panel stays on Research and never
    // re-renders the Topic intake form / "Start research" button.
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "running",
            steps: new Map([["github", { phase: "in-flight" as const }]]),
          } as unknown as RunState
        }
      />,
    );
    screen.getByText("Research progress");
    expect(
      screen.queryByRole("button", { name: /start research/i }),
    ).toBeNull();
    expect(screen.queryByText(/setting up workflow/i)).toBeNull();
  });

  test("the active source surfaces a live activity line under the stepper", () => {
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
            ]),
          } as unknown as RunState
        }
      />,
    );
    screen.getByText(/searching github/i);
  });

  test("while synthesizing, the brief's research stats appear before the full report", () => {
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "running",
            steps: new Map([
              ["intake", { phase: "completed" as const }],
              ["brief", { phase: "completed" as const }],
              ["write", { phase: "in-flight" as const }],
            ]),
          } as unknown as RunState
        }
        stepOutputs={{
          brief: {
            content: JSON.stringify({
              topic: "GTM agents",
              days: 30,
              stats: { sourceCount: 7, itemCount: 42 },
              clusters: [],
              bestTakes: [],
              items: [],
              citations: [
                {
                  url: "https://news.ycombinator.com/item?id=1",
                  source: "hn",
                  retrievedAt: "2026-03-23T12:00:00.000Z",
                  title: "HN thread",
                },
              ],
              generatedAt: "2026-03-23T12:00:00.000Z",
            }),
          },
        }}
      />,
    );
    screen.getByText(/7 sources/i);
    screen.getByText(/42 signals/i);
    screen.getByText(/writing the report/i);
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
