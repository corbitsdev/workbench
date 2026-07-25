import { describe, expect, test } from "bun:test";
import type { ActionHandler } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import { STEP_KIND_TAG } from "@workbench/agents";
import {
  ARTIFACT_CREATE_HANDLER,
  buildAbPresetWorkflow,
  COMPOSE_HANDLER,
  QUORUM_HANDLER,
} from "./builder";
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

function makeActionResolver(
  outputs: Record<string, unknown>,
  calls: { ref: string; input: unknown }[],
): (ref: string) => ActionHandler {
  return (ref: string): ActionHandler => {
    return async (input): Promise<unknown> => {
      calls.push({ ref, input });
      return outputs[ref] ?? null;
    };
  };
}

describe("buildAbPresetWorkflow", () => {
  test("runs the shared prompt across four fixed models then a human pick, composes, persists", async () => {
    const built = buildAbPresetWorkflow(QUALITY_PRESET);
    const { invoker, ran } = makeRecordingInvoker({
      exec0: { reply: "opus" },
      exec1: { reply: "gpt" },
      exec2: { reply: "glm" },
      exec3: { reply: "grok" },
    });
    const actionCalls: { ref: string; input: unknown }[] = [];
    const actionResolver = makeActionResolver(
      {
        [QUORUM_HANDLER]: { survived: 4, total: 4 },
        [COMPOSE_HANDLER]: { content: '{"variants":[]}' },
        [ARTIFACT_CREATE_HANDLER]: { artifactId: "art_1" },
      },
      actionCalls,
    );
    const run = runLocal(built.workflow, {
      invokeStep: invoker,
      actionResolver,
    });

    await run.signal("ab-config", { input: "Write a tagline." });
    await run.signal("ab-decision", {
      ranking: [{ rank: 1, label: "Variant 2" }],
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    // The quorum action dispatches after every variant lane and before
    // compose (the human decision — an awaitSignal — sits between them but
    // isn't invoked).
    const actionOrder = actionCalls.map((c) => c.ref);
    expect(actionOrder).toEqual([
      QUORUM_HANDLER,
      COMPOSE_HANDLER,
      ARTIFACT_CREATE_HANDLER,
    ]);

    // Four separate execute steps ran (not a map), each on the shared prompt.
    const execRuns = ran.filter((r) => r.id.startsWith("exec"));
    expect(execRuns).toHaveLength(4);
    for (const e of execRuns) expect(e.input).toBe("Write a tagline.");

    // The compose action received the FIXED variant metadata as a literal, in
    // order — this is what the quorum/fold reads instead of a config step.
    const compose = actionCalls.find((c) => c.ref === COMPOSE_HANDLER);
    const presetVariants = (compose?.input as { __presetVariants?: unknown })
      .__presetVariants as { label: string; model: string }[];
    expect(presetVariants.map((v) => v.model)).toEqual([
      "claude-opus-4-8",
      "gpt-5.5",
      "glm-5.2",
      "grok-4.5",
    ]);
  });

  test("the quorum gate depends on every variant lane and gates the decision", () => {
    const built = buildAbPresetWorkflow(QUALITY_PRESET);
    const quorum = built.workflow.steps.quorum;
    const decision = built.workflow.steps.decision;
    if (quorum === undefined || quorum.kind !== "action") {
      throw new Error("expected a quorum action");
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
    expect(quorum.handler).toBe(QUORUM_HANDLER);
    expect(quorum.effect).toEqual({ requires: [QUORUM_HANDLER] });
  });

  test("every execute step is a native reasoning step (no dispatch tag) that retries, with no non-fatal degrade", () => {
    const built = buildAbPresetWorkflow(SPEED_PRESET);
    for (let i = 0; i < 4; i += 1) {
      const step = built.workflow.steps[`exec${i}`];
      if (step === undefined || step.kind !== "step") {
        throw new Error(`expected a step primitive for exec${i}`);
      }
      expect(step.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
      expect(step.retry?.maxAttempts).toBe(3);
    }
  });

  test("a variant that still fails after retry exhaustion fails the run — no recorded skip", async () => {
    // The engine's DAG dependency is "terminal", not "succeeded": a
    // downstream step still runs once its failed upstream settles (its
    // `output` is simply absent), so quorum/decision/compose still complete
    // using the three survivors. But the run's overall terminalStatus is
    // "failed" the moment ANY step permanently fails — independent of
    // whether the rest of the DAG went on to complete — so there is no
    // "recorded skip" path left: the run always reports failed and the whole
    // comparison must be rerun.
    const built = buildAbPresetWorkflow(QUALITY_PRESET);
    const invoker: StepInvoker = async ({ agent }) => {
      if (agent.id === "exec2") throw new Error("provider 503");
      return { output: { reply: `${agent.id} answer`, turn: null } };
    };
    const run = runLocal(built.workflow, { invokeStep: invoker });

    await run.signal("ab-config", { input: "Write a tagline." });
    await run.signal("ab-decision", {
      ranking: [{ rank: 1, label: "Variant 1" }],
    });
    const result = await run.complete;

    // The engine's RetryPolicy (maxAttempts: 3) retries the throwing variant
    // twice on real backoff before giving up — proving retry still applies.
    expect(result.terminalStatus).toBe("failed");
  }, 15_000);

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

  test("persist projects compose's content and adds the constant title/kind", () => {
    const built = buildAbPresetWorkflow(QUALITY_PRESET);
    const persist = built.workflow.steps.persist;
    if (persist === undefined || persist.kind !== "action") {
      throw new Error("expected a persist action");
    }
    expect(persist.handler).toBe(ARTIFACT_CREATE_HANDLER);
    expect(persist.input).toEqual({
      merge: [
        { project: { from: "steps.compose.output" }, fields: ["content"] },
        {
          literal: {
            title: `${QUALITY_PRESET.label} Results`,
            kind: "ab-comparison",
          },
        },
      ],
    });
    expect(persist.effect).toEqual({ requires: [ARTIFACT_CREATE_HANDLER] });
    expect(persist.after).toEqual(["compose"]);
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
