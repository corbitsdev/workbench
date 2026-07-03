import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { buildAbCompareHitlBlocks } from "@workbench/workflow-ab-compare-hitl/blocks";
import {
  logRunStateSchema,
  runStateFromLog,
  stepOutputsFromLog,
  type LogRunState,
} from "./run-state-adapter";

// Closes the seam gap (CL-2683 finding F): drives a real log-derived run state
// through the production `stepOutputsFromLog` + `runStateFromLog` decoders —
// exactly what WorkflowDock does — and only THEN into the block builder. The
// prior "integration" test hand-shaped decoded outputs, skipping the inline-ref
// decode that is the actual client seam.

// Build a raw /state response and parse it through the real boundary schema, so
// the test starts from wire-shaped data, not a pre-trusted object.
function parseLog(raw: unknown): LogRunState {
  const parsed = logRunStateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`fixture failed schema: ${parsed.summary}`);
  }
  return parsed;
}

const inline = (value: unknown): string => `inline:${JSON.stringify(value)}`;

describe("ab-compare-hitl blocks — real log→state→blocks seam", () => {
  const rawLog = {
    runId: "run_seam",
    phase: "running" as const,
    lastSeq: 7,
    steps: [
      {
        stepId: "config",
        phase: "completed" as const,
        stepType: "human" as const,
        currentAttempt: 1,
        outputRef: inline({
          variants: [
            { label: "Variant 1", providerName: "openai", model: "gpt-4o" },
            {
              label: "Variant 2",
              providerName: "anthropic",
              model: "claude-3.5",
            },
          ],
          input: "Write a tagline for a GTM workbench.",
        }),
      },
      {
        stepId: "execute",
        phase: "completed" as const,
        stepType: "inline" as const,
        currentAttempt: 1,
        outputRef: inline([
          { reply: "Close deals faster with an AI GTM copilot." },
          { reply: "Your revenue team's shared brain." },
        ]),
      },
      {
        stepId: "decision",
        phase: "awaiting-signal" as const,
        stepType: "human" as const,
        currentAttempt: 1,
        awaitingSignalName: "ab-decision",
      },
    ],
  };

  it("decodes inline outputs and renders blind cards + a winner choice", () => {
    const log = parseLog(rawLog);

    // The production decoders — the seam under test.
    const stepOutputs = stepOutputsFromLog(log);
    const state = runStateFromLog(log);

    const blocks = buildAbCompareHitlBlocks({
      runId: log.runId,
      phase: state.phase,
      steps: log.steps.map((step) => ({
        stepId: step.stepId,
        phase: step.phase,
        ...(step.awaitingSignalName !== undefined
          ? { awaitingSignalName: step.awaitingSignalName }
          : {}),
      })),
      stepOutputs,
    });

    const documents = blocks.filter((b) => b.kind === "document");
    expect(documents.length).toBe(2);
    expect(documents[0]?.kind === "document" && documents[0].source).toContain(
      "Close deals faster",
    );

    const choice = blocks.find((b) => b.kind === "choice");
    expect(choice?.kind).toBe("choice");
    if (choice?.kind === "choice") {
      expect(choice.signalName).toBe("ab-decision");
      expect(choice.options.length).toBe(2);
    }

    // Blind through the real decode path too — no identity leaks post-decode.
    const serialized = JSON.stringify(blocks).toLowerCase();
    for (const identity of ["openai", "gpt-4o", "anthropic", "claude"]) {
      expect(serialized).not.toContain(identity);
    }
  });

  it("omits an out-of-line (blob) execute output, so no actionable pick renders", () => {
    const log = parseLog({
      ...rawLog,
      steps: rawLog.steps.map((step) =>
        step.stepId === "execute"
          ? { ...step, outputRef: "blob:sha256-abc123" }
          : step,
      ),
    });

    const stepOutputs = stepOutputsFromLog(log);
    // The blob ref is not client-resolvable — execute output is absent.
    expect(stepOutputs.execute).toBeUndefined();

    const blocks = buildAbCompareHitlBlocks({
      runId: log.runId,
      phase: runStateFromLog(log).phase,
      steps: log.steps.map((step) => ({
        stepId: step.stepId,
        phase: step.phase,
        ...(step.awaitingSignalName !== undefined
          ? { awaitingSignalName: step.awaitingSignalName }
          : {}),
      })),
      stepOutputs,
    });

    // Nothing to compare → no actionable choice, a run-page link instead.
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    expect(blocks.some((b) => b.kind === "link")).toBe(true);
  });
});
