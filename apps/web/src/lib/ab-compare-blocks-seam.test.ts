import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { buildAbPresetBlocks } from "@workbench/ab-compare-presets/blocks";
import { AbPresetConfigPayloadSchema } from "@workbench/shared";
import {
  logRunStateSchema,
  runStateFromLog,
  stepOutputsFromLog,
  type LogRunState,
} from "./run-state-adapter";

// Drives a real log-derived run state through the production
// `stepOutputsFromLog` + `runStateFromLog` decoders — exactly what WorkflowDock
// does — and only THEN into the preset block builder, so the test starts from
// wire-shaped data (including the inline-ref decode that is the client seam),
// not a pre-trusted object.

function parseLog(raw: unknown): LogRunState {
  const parsed = logRunStateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`fixture failed schema: ${parsed.summary}`);
  }
  return parsed;
}

const inline = (value: unknown): string => `inline:${JSON.stringify(value)}`;

function stepsForBlocks(log: LogRunState) {
  return log.steps.map((step) => ({
    stepId: step.stepId,
    phase: step.phase,
    ...(step.awaitingSignalName !== undefined
      ? { awaitingSignalName: step.awaitingSignalName }
      : {}),
  }));
}

describe("ab-compare presets — real log→state→blocks seam", () => {
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
        outputRef: inline({ input: "Write a tagline for a GTM workbench." }),
      },
      {
        stepId: "exec0",
        phase: "completed" as const,
        stepType: "inline" as const,
        currentAttempt: 1,
        outputRef: inline({ reply: "Close deals faster with an AI copilot." }),
      },
      {
        stepId: "exec1",
        phase: "completed" as const,
        stepType: "inline" as const,
        currentAttempt: 1,
        outputRef: inline({ reply: "Your revenue team's shared brain." }),
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

  it("decodes inline exec outputs into blind cards + a winner choice", () => {
    const log = parseLog(rawLog);
    const stepOutputs = stepOutputsFromLog(log);
    const state = runStateFromLog(log);

    const blocks = buildAbPresetBlocks({
      runId: log.runId,
      phase: state.phase,
      steps: stepsForBlocks(log),
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

    // Blind: the pick surface carries only the blind labels, never a model id.
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("Variant 1");
    expect(serialized).toContain("Variant 2");
  });

  it("at the config gate renders a prompt-only form whose payload validates", () => {
    const log = parseLog({
      runId: "run_cfg",
      phase: "running" as const,
      lastSeq: 1,
      steps: [
        {
          stepId: "config",
          phase: "awaiting-signal" as const,
          stepType: "human" as const,
          currentAttempt: 1,
          awaitingSignalName: "ab-config",
        },
      ],
    });

    const blocks = buildAbPresetBlocks({
      runId: log.runId,
      phase: runStateFromLog(log).phase,
      steps: stepsForBlocks(log),
      stepOutputs: stepOutputsFromLog(log),
    });

    const form = blocks.find((b) => b.kind === "form");
    if (form?.kind !== "form") throw new Error("expected a form block");
    expect(form.signalName).toBe("ab-config");
    expect(form.fields.map((f) => f.name)).toEqual(["input"]);

    // The payload the FormBlock emits from THIS field validates at the boundary.
    const payload: Record<string, unknown> = {
      [form.fields[0]!.name]: "Ship it.",
    };
    expect(AbPresetConfigPayloadSchema(payload) instanceof type.errors).toBe(
      false,
    );
  });
});
