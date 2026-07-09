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

function comparisonBlock(
  blocks: UIBlock[],
): Extract<UIBlock, { kind: "comparison" }> {
  const comparison = blocks.find((b) => b.kind === "comparison");
  if (comparison === undefined || comparison.kind !== "comparison") {
    throw new Error("no comparison");
  }
  return comparison;
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

  test("in-flight execs emit ONE comparison block with streaming variants, not documents", () => {
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

    // No document cards — one unified comparison block carries every lane.
    expect(blocks.some((b) => b.kind === "document")).toBe(false);
    expect(blocks.filter((b) => b.kind === "comparison")).toHaveLength(1);

    const comparison = comparisonBlock(blocks);
    expect(comparison.status).toBe("running");
    expect(comparison.blind).toBe(true);
    const statuses = comparison.result.variants.map((v) => v.status);
    expect(statuses).toEqual(["responded", "streaming"]);
    // The finished lane keeps its content in place while the other streams.
    expect(comparison.result.variants[0]?.content).toBe("opus answer");
  });

  test("once every lane is terminal the block flips to final with per-variant statuses", () => {
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
    expect(blocks.some((b) => b.kind === "document")).toBe(false);

    const comparison = comparisonBlock(blocks);
    expect(comparison.status).toBe("final");
    // Every variant keeps its slot; the failed lane is no-response, never dropped.
    expect(comparison.result.variants.map((v) => v.status)).toEqual([
      "responded",
      "responded",
      "no-response",
      "responded",
    ]);
    // Blind: labels never leak a model identity.
    for (const v of comparison.result.variants) {
      expect(v.label).toMatch(/^Variant \d$/u);
    }

    // The choice offers exactly the three variants that produced an answer.
    const choice = choiceBlock(blocks);
    expect(choice.signalName).toBe("ab-decision");
    expect(choice.options.map((o) => o.value)).toEqual([
      "Variant 1",
      "Variant 2",
      "Variant 4",
    ]);
    const payload = choice.options[0]?.payload as {
      ranking: { rank: number; label: string }[];
    };
    expect(payload.ranking[0]).toEqual({ rank: 1, label: "Variant 1" });
  });

  test("degraded run: comparison block with a no-response variant, no did-not-respond text, no documents", () => {
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
    expect(blocks.some((b) => b.kind === "document")).toBe(false);
    // No alarming "did not respond" tally block — the comparison grid's survivor
    // pill is the single, calm count.
    expect(
      blocks.some(
        (b) => b.kind === "text" && b.text.includes("did not respond"),
      ),
    ).toBe(false);

    const comparison = comparisonBlock(blocks);
    expect(comparison.result.variants.map((v) => v.status)).toEqual([
      "responded",
      "no-response",
      "responded",
    ]);
  });

  test("all-variants-failed: a comparison block of no-response cells, a run error, no documents", () => {
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
    expect(blocks.some((b) => b.kind === "document")).toBe(false);

    const comparison = comparisonBlock(blocks);
    expect(
      comparison.result.variants.every((v) => v.status === "no-response"),
    ).toBe(true);

    // The total-quorum-failure error path is preserved.
    expect(
      blocks.some(
        (b) =>
          b.kind === "error" &&
          b.message === "only 0 of 2 models produced an answer",
      ),
    ).toBe(true);

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
