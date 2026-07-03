import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { pendingGateForRun } from "@workbench/blocks";
import { composeComparisonResult } from "@workbench/tools-ab-compare";
import { AbDecisionPayloadSchema } from "@workbench/shared";
import {
  buildAbCompareHitlBlocks,
  CONFIG_SIGNAL,
  DECISION_SIGNAL,
} from "./blocks";

// Integration test across the real seams this migration owns (CL-2683):
//   run-state → block builder → resume-routing derivation → verbatim signal
//   payload → resume-boundary validation → compose tool → composed artifact.
//
// Nothing here is mocked: `buildAbCompareHitlBlocks`, the shared
// `pendingGateForRun` routing derivation, the `AbDecisionPayloadSchema` resume
// validator, and `composeComparisonResult` are all production units. The execute
// step's variant outputs are supplied as runtime-shaped data (an LLM turn is
// data, not a seam under test); the `awaitSignal` step output equals the resume
// payload verbatim, so feeding a block's payload as `steps.decision.output`
// reproduces exactly what the runtime hands the compose step at resume.

// The `stepOutputs` map is the run-keyed log fold's shape (stepId → decoded
// output), as `stepOutputsFromLog` produces on the client.
const stepOutputs: Record<string, unknown> = {
  config: {
    variants: [
      { label: "Variant 1", providerName: "openai", model: "gpt-4o" },
      { label: "Variant 2", providerName: "anthropic", model: "claude-3.5" },
    ],
    input: "Write a tagline for a GTM workbench.",
  },
  execute: [
    { reply: "Close deals faster with an AI GTM copilot." },
    { reply: "Your revenue team's shared brain." },
  ],
};

// Every provider/model identity string that must NOT appear before the decision.
const IDENTITY_STRINGS = ["openai", "gpt-4o", "anthropic", "claude"];

function serializeBlocks(blocks: unknown): string {
  return JSON.stringify(blocks).toLowerCase();
}

// A run parked on the human decision gate: execute done, decision awaiting.
const awaitingDecisionSteps = [
  { stepId: "config", phase: "completed" as const },
  { stepId: "execute", phase: "completed" as const },
  {
    stepId: "decision",
    phase: "awaiting-signal" as const,
    awaitingSignalName: DECISION_SIGNAL,
  },
];

describe("ab-compare-hitl blocks (integration)", () => {
  it("emits progress, blind per-variant output cards, and a winner choice at the decision gate", () => {
    const blocks = buildAbCompareHitlBlocks({
      runId: "run_1",
      phase: "running",
      steps: awaitingDecisionSteps,
      stepOutputs,
    });

    const progress = blocks.find((b) => b.kind === "progress");
    expect(progress?.kind).toBe("progress");
    if (progress?.kind === "progress") {
      expect(progress.steps.length).toBe(3);
    }

    // One document card per variant, each carrying the full blind output.
    const documents = blocks.filter((b) => b.kind === "document");
    expect(documents.length).toBe(2);
    expect(documents[0]?.kind === "document" && documents[0].source).toContain(
      "Close deals faster",
    );
    expect(documents[1]?.kind === "document" && documents[1].source).toContain(
      "shared brain",
    );

    const choice = blocks.find((b) => b.kind === "choice");
    expect(choice?.kind).toBe("choice");
    if (choice?.kind === "choice") {
      const gate = pendingGateForRun({
        runId: "run_1",
        steps: awaitingDecisionSteps,
      });
      expect(gate?.signalName).toBe(DECISION_SIGNAL);
      expect(choice.signalName).toBe(gate?.signalName);
      expect(choice.options.length).toBe(2);
      expect(choice.options[0]?.payload).toBeDefined();
      // The choice carries a prompt-box so the reviewer's rationale reaches the
      // artifact (dock/panel parity, CL-2683).
      expect(choice.promptBox?.payloadKey).toBe("rationale");
    }
  });

  it("reveals no provider/model identity before the decision (blind pick)", () => {
    const blocks = buildAbCompareHitlBlocks({
      runId: "run_1",
      phase: "running",
      steps: awaitingDecisionSteps,
      stepOutputs,
    });
    const serialized = serializeBlocks(blocks);
    for (const identity of IDENTITY_STRINGS) {
      expect(serialized).not.toContain(identity);
    }
  });

  it("at the config gate emits a run-page link, never an empty-submit choice", () => {
    const configSteps = [
      {
        stepId: "config",
        phase: "awaiting-signal" as const,
        awaitingSignalName: CONFIG_SIGNAL,
      },
    ];
    const blocks = buildAbCompareHitlBlocks({
      runId: "run_1",
      phase: "running",
      steps: configSteps,
      stepOutputs: {},
    });
    // No choice — a "Continue" choice would POST `{ instruction: "" }` and
    // corrupt the run (execute would fold `variants` to undefined).
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    const link = blocks.find((b) => b.kind === "link");
    expect(link?.kind).toBe("link");
    if (link?.kind === "link") {
      expect(link.url).toBe("/workflows/run_1");
    }
  });

  it("at the decision gate with no resolvable outputs, links to the run page instead of an actionable choice", () => {
    const blocks = buildAbCompareHitlBlocks({
      runId: "run_1",
      phase: "running",
      steps: awaitingDecisionSteps,
      // No decoded outputs (e.g. stored out of line / blob refs) — the pick would
      // be blind of everything, so no choice may render.
      stepOutputs: { config: stepOutputs.config },
    });
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    expect(blocks.some((b) => b.kind === "document")).toBe(false);
    expect(blocks.some((b) => b.kind === "link")).toBe(true);
  });

  it("winner choice payload composes to a real human decision with the picked variant ranked first", () => {
    const blocks = buildAbCompareHitlBlocks({
      runId: "run_1",
      phase: "running",
      steps: awaitingDecisionSteps,
      stepOutputs,
    });
    const choice = blocks.find((b) => b.kind === "choice");
    if (choice?.kind !== "choice") throw new Error("expected a choice block");

    // Pick Variant 2. Its payload becomes `steps.decision.output` verbatim, plus
    // the prompt-box rationale the ChoiceBlock folds in on selection.
    const picked = choice.options.find((o) => o.label.includes("Variant 2"));
    expect(picked?.payload).toBeDefined();
    const payloadWithRationale = {
      ...(picked?.payload as Record<string, unknown>),
      rationale: "Punchier and more memorable.",
    };

    const composed = composeComparisonResult({
      config: { output: stepOutputs.config },
      execute: { output: stepOutputs.execute },
      decision: { output: payloadWithRationale },
    });

    expect(composed.decidedBy).toBe("human");
    const winner = composed.ranking.find((r) => r.rank === 1);
    expect(winner?.label).toBe("Variant 2");
    // The top-level rationale folds onto the winner — dock/panel artifact parity.
    expect(winner?.rationale).toBe("Punchier and more memorable.");
    expect(composed.ranking.length).toBe(2);
    expect(composed.variants.length).toBe(2);
    expect(composed.variants[1]?.content).toContain("shared brain");
  });

  it("REJECTS a free-text-only decision at the resume boundary (a blind pick is not free text)", () => {
    // Free text carries no ranking; a winner-less "decision" would fold to a
    // hollow artifact, so the boundary schema rejects it (CL-2683). The gate is
    // only satisfiable by a structured ranked pick.
    const rejected = AbDecisionPayloadSchema({
      instruction: "Variant 1 reads better to me.",
    });
    expect(rejected instanceof type.errors).toBe(true);

    const accepted = AbDecisionPayloadSchema({
      ranking: [{ rank: 1, label: "Variant 1" }],
    });
    expect(accepted instanceof type.errors).toBe(false);
  });

  it("shows the completion link and no choice once the run has published", () => {
    const blocks = buildAbCompareHitlBlocks({
      runId: "run_1",
      phase: "completed",
      steps: [
        { stepId: "config", phase: "completed" },
        { stepId: "execute", phase: "completed" },
        { stepId: "decision", phase: "completed" },
        { stepId: "compose", phase: "completed" },
        { stepId: "persist", phase: "completed" },
      ],
      stepOutputs,
      completedLink: {
        url: "/workflows/run_1",
        title: "View results",
      },
    });
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    expect(blocks.some((b) => b.kind === "link")).toBe(true);
  });
});
