import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import { STEP_KIND_TAG, STEP_NONFATAL_TAG } from "@workbench/agents";
import { buildAbPresetWorkflow } from "./builder";
import {
  AB_PRESETS,
  QUALITY_PRESET,
  SPEED_PRESET,
  STANDARD_PRESET,
} from "./presets";

function makeRecordingInvoker(outputs: Record<string, unknown> = {}): {
  invoker: StepInvoker;
  ran: { id: string; input: unknown }[];
} {
  const ran: { id: string; input: unknown }[] = [];
  const invoker: StepInvoker = async ({ agent, input }) => {
    ran.push({ id: agent.id, input });
    return { output: outputs[agent.id] ?? null };
  };
  return { invoker, ran };
}

describe("buildAbPresetWorkflow", () => {
  test("runs the shared prompt across four fixed models then a human pick, composes, persists", async () => {
    const built = buildAbPresetWorkflow(QUALITY_PRESET);
    const { invoker, ran } = makeRecordingInvoker({
      exec0: { reply: "opus" },
      exec1: { reply: "gpt" },
      exec2: { reply: "glm" },
      exec3: { reply: "grok" },
      quorum: { survived: 4, total: 4 },
      compose: { content: '{"variants":[]}' },
      persist: { artifactId: "art_1" },
    });
    const run = runLocal(built.workflow, { invokeStep: invoker });

    await run.signal("ab-config", { input: "Write a tagline." });
    await run.signal("ab-decision", {
      ranking: [{ rank: 1, label: "Variant 2" }],
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    // The quorum gate runs after every variant lane and before compose (the
    // human decision — an awaitSignal — sits between them but isn't invoked).
    const order = ran.map((r) => r.id);
    const lastExec = Math.max(
      ...order.flatMap((id, i) => (id.startsWith("exec") ? [i] : [])),
    );
    expect(order.filter((id) => id.startsWith("exec")).length).toBe(4);
    expect(order.indexOf("quorum")).toBeGreaterThan(lastExec);
    expect(order.indexOf("quorum")).toBeLessThan(order.indexOf("compose"));

    // Four separate execute steps ran (not a map), each on the shared prompt.
    const execRuns = ran.filter((r) => r.id.startsWith("exec"));
    expect(execRuns).toHaveLength(4);
    for (const e of execRuns) expect(e.input).toBe("Write a tagline.");

    // The compose step received the FIXED variant metadata as a literal, in
    // order — this is what the quorum/fold reads instead of a config step.
    const compose = ran.find((r) => r.id === "compose");
    const presetVariants = (compose?.input as { __presetVariants?: unknown })
      .__presetVariants as { label: string; model: string }[];
    expect(presetVariants.map((v) => v.model)).toEqual([
      "claude-opus-4-8",
      "gpt-5.5",
      "glm-5.2",
      "grok-4.5",
    ]);

    expect(ran.map((r) => r.id)).toContain("persist");
  });

  test("the quorum gate depends on every variant lane and gates the decision", () => {
    const built = buildAbPresetWorkflow(QUALITY_PRESET);
    const quorum = built.workflow.steps.quorum;
    const decision = built.workflow.steps.decision;
    if (quorum === undefined || quorum.kind !== "step") {
      throw new Error("expected a quorum step");
    }
    if (decision === undefined || decision.kind !== "awaitSignal") {
      throw new Error("expected a decision awaitSignal");
    }
    // Quorum runs after all four variant lanes; the human decision runs after
    // quorum — so a sub-quorum run (quorum throws) fails before the decision.
    expect([...(quorum.after ?? [])].sort()).toEqual([
      "exec0",
      "exec1",
      "exec2",
      "exec3",
    ]);
    expect(decision.after).toEqual(["quorum"]);
    // The tool name is canonicalized to its package factory id at build time.
    expect(quorum.agent.tags?.["workbench.tool"]).toContain("ab_preset_quorum");
  });

  test("every execute step is inline-inference, non-fatal, and retries", () => {
    const built = buildAbPresetWorkflow(SPEED_PRESET);
    for (let i = 0; i < 4; i += 1) {
      const step = built.workflow.steps[`exec${i}`];
      if (step === undefined || step.kind !== "step") {
        throw new Error(`expected a step primitive for exec${i}`);
      }
      expect(step.agent.tags?.[STEP_KIND_TAG]).toBe("inline-inference");
      expect(step.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
      expect(step.retry?.maxAttempts).toBe(3);
    }
  });

  test("each execute step pins its own fixed model (not a shared map source)", () => {
    const built = buildAbPresetWorkflow(STANDARD_PRESET);
    const models = [0, 1, 2, 3].map((i) => {
      const step = built.workflow.steps[`exec${i}`];
      if (step === undefined || step.kind !== "step") {
        throw new Error("expected step");
      }
      return step.agent.inference.sources[0]?.model;
    });
    expect(models).toEqual([
      "claude-sonnet-5",
      "kimi-k2.6",
      "gpt-5.4",
      "gemini-3.1-pro",
    ]);
  });

  test("the three presets expose distinct kinds and four variants each", () => {
    const kinds = AB_PRESETS.map((p) => p.kind);
    expect(kinds).toEqual([
      "ab-compare-quality",
      "ab-compare-speed",
      "ab-compare-standard",
    ]);
    for (const preset of AB_PRESETS) {
      expect(preset.variants).toHaveLength(4);
      const built = buildAbPresetWorkflow(preset);
      expect(built.workflow.id).toBe(preset.kind);
    }
  });
});
