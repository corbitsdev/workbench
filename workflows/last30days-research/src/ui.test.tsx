import { describe, expect, test } from "bun:test";
import type { RunState } from "@intx/workflow";
import { render, screen } from "@testing-library/react";
import { Panel } from "./ui";

const baseProps = {
  deploymentId: "run-1",
  logRead: true,
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

  test("after intake submit (signal pending) shows a live working state, not the dead 'Setting up workflow' copy (CL-2787)", () => {
    // The user submitted the topic: the intake gate has left awaiting-signal but
    // research has not produced steps yet. This transition window must read as
    // live/working, not the pre-gate "Setting up workflow" placeholder.
    render(
      <Panel
        {...baseProps}
        signalPending
        state={
          {
            phase: "running",
            steps: new Map([["intake", { phase: "in-flight" as const }]]),
          } as unknown as RunState
        }
      />,
    );
    screen.getByText(/starting research/i);
    expect(screen.queryByText(/setting up workflow/i)).toBeNull();
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
    const synthesisCard = screen.getByText("Synthesis").closest("section.p-6");
    expect(synthesisCard).not.toBeNull();
    expect(
      synthesisCard?.parentElement?.closest("section.p-6") ?? null,
    ).toBeNull();
  });

  test("names the failed step and shows the sanitized error, never raw internals (CL-2659)", () => {
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "failed",
            steps: new Map([
              ["intake", { phase: "completed" }],
              ["ground", { phase: "completed" }],
              ["brief", { phase: "completed" }],
              [
                "write",
                {
                  phase: "failed",
                  lastError: {
                    message:
                      "TypeError: boom at run (ins_01abc/ses_01def) /app/steps/write.ts:42:7",
                  },
                },
              ],
            ]),
          } as unknown as RunState
        }
      />,
    );
    screen.getByText("Run failed at Report");
    screen.getByText(/Something went wrong inside this workflow run/);
    expect(screen.queryByText(/ins_/)).toBeNull();
    expect(screen.queryByText(/ses_/)).toBeNull();
    expect(screen.queryByText(/TypeError/)).toBeNull();
  });

  test("falls back to an honest no-details message on a failed run with no step error", () => {
    // A step ran and failed (so the run DID start) but carries no error — heading
    // stays "Run failed", message degrades to the honest no-details line. Uses a
    // step id outside DISPLAY_STEPS so no display label is resolved.
    render(
      <Panel
        {...baseProps}
        state={
          {
            phase: "failed",
            steps: new Map([["ghost", { phase: "failed" }]]),
          } as unknown as RunState
        }
      />,
    );
    screen.getByText("Run failed");
    screen.getByText(/No error details are available/);
  });

  test("does NOT claim didn't-start when the log was unavailable on a failed run", () => {
    // Same empty-step shape, but the log was unavailable (logRead false) so the
    // run state was synthesized from the index — we don't know whether it
    // started, so show the generic couldn't-load copy, never "This run didn't
    // start" (CL-2729).
    render(
      <Panel
        {...baseProps}
        logRead={false}
        state={{ phase: "failed", steps: new Map() } as unknown as RunState}
      />,
    );
    screen.getByText("Run failed");
    screen.getByText(/couldn't load this run's details/);
    expect(screen.queryByText("This run didn't start")).toBeNull();
  });
});
