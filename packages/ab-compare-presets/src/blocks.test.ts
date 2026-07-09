import { describe, expect, test } from "bun:test";
import type { UIBlock } from "@workbench/blocks";
import { buildAbPresetBlocks, type AbPresetBlockInput } from "./blocks";

function formBlock(blocks: UIBlock[]): Extract<UIBlock, { kind: "form" }> {
  const form = blocks.find((b) => b.kind === "form");
  if (form === undefined || form.kind !== "form") throw new Error("no form");
  return form;
}

function choiceBlock(blocks: UIBlock[]): Extract<UIBlock, { kind: "choice" }> {
  const choice = blocks.find((b) => b.kind === "choice");
  if (choice === undefined || choice.kind !== "choice") {
    throw new Error("no choice");
  }
  return choice;
}

describe("buildAbPresetBlocks", () => {
  test("the config gate renders a prompt-only form (no provider/model fields)", () => {
    const input: AbPresetBlockInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        {
          stepId: "config",
          phase: "awaiting-signal",
          awaitingSignalName: "ab-config",
        },
      ],
      stepOutputs: {},
    };
    const form = formBlock(buildAbPresetBlocks(input));
    expect(form.signalName).toBe("ab-config");
    expect(form.fields.map((f) => f.name)).toEqual(["input"]);
  });

  test("blind variant outputs skip a failed variant and offer a winner choice", () => {
    const input: AbPresetBlockInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        { stepId: "config", phase: "completed" },
        { stepId: "exec0", phase: "completed" },
        { stepId: "exec1", phase: "completed" },
        { stepId: "exec2", phase: "completed" },
        { stepId: "exec3", phase: "completed" },
        {
          stepId: "decision",
          phase: "awaiting-signal",
          awaitingSignalName: "ab-decision",
        },
      ],
      stepOutputs: {
        exec0: { reply: "opus answer" },
        exec1: { reply: "gpt answer" },
        exec2: { reply: "", isError: true, error: "provider 503" },
        exec3: { reply: "grok answer" },
      },
    };
    const blocks = buildAbPresetBlocks(input);

    // The failed variant (exec2) produces no document; the other three do.
    const docs = blocks.filter((b) => b.kind === "document");
    expect(docs.map((d) => (d.kind === "document" ? d.title : ""))).toEqual([
      "Variant 1",
      "Variant 2",
      "Variant 4",
    ]);
    // Outputs never leak a model identity (blind).
    for (const d of docs) {
      if (d.kind === "document") {
        expect(d.title).toMatch(/^Variant \d$/u);
      }
    }
    // The choice offers exactly the three variants that produced an answer.
    const choice = choiceBlock(blocks);
    expect(choice.signalName).toBe("ab-decision");
    expect(choice.options.map((o) => o.value)).toEqual([
      "Variant 1",
      "Variant 2",
      "Variant 4",
    ]);
    // The winner's payload ranks it first.
    const firstOption = choice.options[0];
    const payload = firstOption?.payload as {
      ranking: { rank: number; label: string }[];
    };
    expect(payload.ranking[0]).toEqual({ rank: 1, label: "Variant 1" });
  });

  test("hides all results until every lane finishes (no incremental reveal)", () => {
    const input: AbPresetBlockInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        { stepId: "config", phase: "completed" },
        { stepId: "exec0", phase: "completed" },
        { stepId: "exec1", phase: "in-flight" },
      ],
      // exec0 already produced output, but exec1 is still running.
      stepOutputs: { exec0: { reply: "opus answer" } },
    };
    const blocks = buildAbPresetBlocks(input);
    // No document cards yet — results appear together once all lanes finish.
    expect(blocks.some((b) => b.kind === "document")).toBe(false);
    const placeholder = blocks.find((b) => b.kind === "text");
    expect(placeholder?.kind === "text" && placeholder.text).toMatch(
      /once they all finish/u,
    );
  });

  test("notes how many models did not respond once all lanes finish", () => {
    const input: AbPresetBlockInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        { stepId: "exec0", phase: "completed" },
        { stepId: "exec1", phase: "completed" },
        { stepId: "exec2", phase: "completed" },
      ],
      stepOutputs: {
        exec0: { reply: "a" },
        exec1: { reply: "", isError: true },
        exec2: { reply: "c" },
      },
    };
    const blocks = buildAbPresetBlocks(input);
    expect(blocks.filter((b) => b.kind === "document")).toHaveLength(2);
    const note = blocks.find(
      (b) => b.kind === "text" && b.text.includes("did not respond"),
    );
    expect(note?.kind === "text" && note.text).toContain(
      "1 of 3 models did not respond",
    );
  });

  test("all-variants-failed: no cards, a dock-voiced message, and failed progress states", () => {
    const input: AbPresetBlockInput = {
      runId: "run_1",
      phase: "failed",
      errorMessage: "only 0 of 2 models produced an answer",
      steps: [
        { stepId: "exec0", phase: "completed" },
        { stepId: "exec1", phase: "completed" },
        { stepId: "quorum", phase: "failed" },
      ],
      stepOutputs: {
        exec0: { reply: "", isError: true },
        exec1: { reply: "", isError: true },
      },
    };
    const blocks = buildAbPresetBlocks(input);
    // No output cards, and a message in the dock's own voice (not only the raw
    // error string).
    expect(blocks.some((b) => b.kind === "document")).toBe(false);
    const note = blocks.find(
      (b) => b.kind === "text" && b.text.includes("None of the models"),
    );
    expect(note).toBeDefined();
    // The failed variant lanes are shown as failed, not a misleading green done.
    const progress = blocks.find((b) => b.kind === "progress");
    if (progress?.kind !== "progress") throw new Error("no progress block");
    const variantStates = progress.steps
      .filter((s) => (s.label ?? "").startsWith("Variant"))
      .map((s) => s.state);
    expect(variantStates).toEqual(["failed", "failed"]);
  });

  test("humanizes progress labels: exec ids read as Variant N", () => {
    const input: AbPresetBlockInput = {
      runId: "run_1",
      phase: "running",
      steps: [
        { stepId: "exec0", phase: "in-flight" },
        { stepId: "quorum", phase: "in-flight" },
      ],
      stepOutputs: {},
    };
    const progress = buildAbPresetBlocks(input).find(
      (b) => b.kind === "progress",
    );
    if (progress?.kind !== "progress") throw new Error("no progress block");
    expect(progress.steps.map((s) => s.label)).toEqual([
      "Variant 1",
      "Check models",
    ]);
  });
});
