import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  buildPainPointCollateralBlocks,
  NOTE_SELECTION_SIGNAL,
  REVIEW_SIGNAL,
} from "@workbench/workflow-pain-point-collateral/blocks";
import {
  PainPointNoteSelectionPayloadSchema,
  PainPointReviewPayloadSchema,
} from "@workbench/shared";
import {
  logRunStateSchema,
  runStateFromLog,
  stepOutputsFromLog,
  type LogRunState,
} from "./run-state-adapter";

// Drives real log-derived run state through the production `stepOutputsFromLog` +
// `runStateFromLog` decoders — exactly what WorkflowDock does — and only THEN into
// the block builder, so the test starts from wire-shaped data (inline outputRefs),
// not a pre-trusted object (CL-2775, mirrors the gamma/last30days seam tests).
// Then asserts the emitted block payloads validate at the /resume boundary schema
// the hub enforces.

const inline = (value: unknown): string => `inline:${JSON.stringify(value)}`;

function parseLog(raw: unknown): LogRunState {
  const parsed = logRunStateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`fixture failed schema: ${parsed.summary}`);
  }
  return parsed;
}

function toSteps(log: LogRunState) {
  return log.steps.map((step) => ({
    stepId: step.stepId,
    phase: step.phase,
    ...(step.awaitingSignalName !== undefined
      ? { awaitingSignalName: step.awaitingSignalName }
      : {}),
  }));
}

// A Granola tool step's log output is the tool result envelope: { content: JSON }.
const toolEnvelope = (value: unknown) => ({ content: JSON.stringify(value) });
const reply = (value: unknown) => ({ reply: JSON.stringify(value) });

describe("pain-point-collateral blocks — real log→state→blocks seam (CL-2775)", () => {
  it("emits a note-selection choice whose {noteId} payload validates at the resume boundary", () => {
    const log = parseLog({
      runId: "run_ppc",
      phase: "running" as const,
      lastSeq: 2,
      steps: [
        {
          stepId: "intake",
          phase: "completed" as const,
          stepType: "deterministic" as const,
          currentAttempt: 1,
          outputRef: inline(
            toolEnvelope({ notes: [{ id: "note_1", title: "Acme call" }] }),
          ),
        },
        {
          stepId: "select",
          phase: "awaiting-signal" as const,
          stepType: "human" as const,
          currentAttempt: 1,
          awaitingSignalName: NOTE_SELECTION_SIGNAL,
        },
      ],
    });

    const blocks = buildPainPointCollateralBlocks({
      runId: log.runId,
      phase: runStateFromLog(log).phase,
      steps: toSteps(log),
      stepOutputs: stepOutputsFromLog(log),
    });

    const choice = blocks.find((b) => b.kind === "choice");
    if (choice?.kind !== "choice") throw new Error("expected a choice block");
    expect(choice.signalName).toBe(NOTE_SELECTION_SIGNAL);
    const payload = choice.options[0]?.payload;
    expect(
      PainPointNoteSelectionPayloadSchema(payload) instanceof type.errors,
    ).toBe(false);
  });

  it("emits a review reviewList whose full-piece payload validates at the resume boundary", () => {
    const pieces = [
      { format: "email", title: "Follow-up", content: "Hi Acme…" },
      { format: "blog", title: "Onboarding tax", content: "# Body" },
    ];
    const log = parseLog({
      runId: "run_ppc2",
      phase: "running" as const,
      lastSeq: 5,
      steps: [
        {
          stepId: "generate",
          phase: "completed" as const,
          stepType: "inline" as const,
          currentAttempt: 1,
          outputRef: inline(pieces.map((p) => reply(p))),
        },
        {
          stepId: "review",
          phase: "awaiting-signal" as const,
          stepType: "human" as const,
          currentAttempt: 1,
          awaitingSignalName: REVIEW_SIGNAL,
        },
      ],
    });

    const blocks = buildPainPointCollateralBlocks({
      runId: log.runId,
      phase: runStateFromLog(log).phase,
      steps: toSteps(log),
      stepOutputs: stepOutputsFromLog(log),
    });

    const review = blocks.find((b) => b.kind === "reviewList");
    if (review?.kind !== "reviewList") throw new Error("expected reviewList");

    // The payload the ReviewListBlock emits when every row is approved — full
    // piece payloads under `approvedPieces` plus the per-row `decisions`.
    const approvedPieces = review.rows.map((r) => r.payload);
    const decisions = review.rows.map((r) => ({
      ...(r.payload as Record<string, unknown>),
      approved: true,
    }));
    const payload = {
      [review.approvedKey ?? "approvedPieces"]: approvedPieces,
      decisions,
    };
    expect(PainPointReviewPayloadSchema(payload) instanceof type.errors).toBe(
      false,
    );

    // A display-fields-only payload (content stripped) is rejected at the same
    // boundary — the fidelity contract the persist argMap depends on (CL-2775).
    const stripped = {
      approvedPieces: approvedPieces.map((p) => {
        const { content: _content, ...rest } = p as Record<string, unknown>;
        return rest;
      }),
      decisions,
    };
    expect(PainPointReviewPayloadSchema(stripped) instanceof type.errors).toBe(
      true,
    );
  });
});
