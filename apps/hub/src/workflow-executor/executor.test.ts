import { describe, expect, test } from "bun:test";
import {
  advanceRun,
  resumeRun,
  type ExecutorDeps,
  type RunState,
} from "./executor";
import type { ProjectedWorkflow } from "./projection";

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "run_1",
    kind: "test",
    tenantId: "t1",
    principalId: "p1",
    status: "running",
    currentStepId: null,
    input: { seed: "in" },
    outputs: {},
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): {
  deps: ExecutorDeps;
  saves: RunState[];
  toolCalls: { tool: string; input: unknown }[];
  reasoningCalls: { stepId: string; input: unknown }[];
} {
  const saves: RunState[] = [];
  const toolCalls: { tool: string; input: unknown }[] = [];
  const reasoningCalls: { stepId: string; input: unknown }[] = [];
  const deps: ExecutorDeps = {
    store: {
      save: async (state) => {
        // snapshot the mutable state at save time
        saves.push(structuredClone(state));
      },
    },
    toolRunner: {
      run: async ({ tool, input }) => {
        toolCalls.push({ tool, input });
        return { ok: tool, echoed: input };
      },
    },
    reasoningRunner: {
      run: async ({ stepId, input }) => {
        reasoningCalls.push({ stepId, input });
        return { reply: `reasoned:${stepId}` };
      },
    },
    ...overrides,
  };
  return { deps, saves, toolCalls, reasoningCalls };
}

describe("advanceRun", () => {
  test("runs a deterministic tool step, saves its output, completes", async () => {
    const wf: ProjectedWorkflow = {
      id: "wf",
      order: ["fetch"],
      steps: {
        fetch: {
          kind: "tool",
          id: "fetch",
          tool: "granola_get_note",
          input: { literal: { noteId: "n1" } },
          after: [],
        },
      },
    };
    const { deps, toolCalls } = makeDeps();
    const state = await advanceRun(wf, deps, makeState());

    expect(toolCalls).toEqual([
      { tool: "granola_get_note", input: { noteId: "n1" } },
    ]);
    expect(state.status).toBe("completed");
    expect(state.outputs.fetch).toEqual({
      ok: "granola_get_note",
      echoed: { noteId: "n1" },
    });
    expect(state.currentStepId).toBeNull();
  });

  test("runs a reasoning step with merged input from prior outputs", async () => {
    const wf: ProjectedWorkflow = {
      id: "wf",
      order: ["analyze"],
      steps: {
        analyze: {
          kind: "reasoning",
          id: "analyze",
          systemPrompt: "extract",
          source: { provider: "openai-compatible", model: "m" },
          input: { merge: [{ from: "steps.fetch.output" }] },
          after: [],
        },
      },
    };
    const { deps, reasoningCalls } = makeDeps();
    const state = await advanceRun(
      wf,
      deps,
      makeState({ outputs: { fetch: { transcript: "hello" } } }),
    );

    expect(reasoningCalls).toEqual([
      { stepId: "analyze", input: { transcript: "hello" } },
    ]);
    expect(state.outputs.analyze).toEqual({ reply: "reasoned:analyze" });
    expect(state.status).toBe("completed");
  });

  test("parks at a gate with status awaiting and persists currentStepId", async () => {
    const wf: ProjectedWorkflow = {
      id: "wf",
      order: ["intake", "select", "fetch"],
      steps: {
        intake: {
          kind: "tool",
          id: "intake",
          tool: "granola_list_notes",
          input: { literal: {} },
          after: [],
        },
        select: {
          kind: "gate",
          id: "select",
          signalName: "note-selection",
          after: ["intake"],
        },
        fetch: {
          kind: "tool",
          id: "fetch",
          tool: "granola_get_note",
          input: { from: "steps.select.output" },
          after: ["select"],
        },
      },
    };
    const { deps, toolCalls } = makeDeps();
    const state = await advanceRun(wf, deps, makeState());

    expect(state.status).toBe("awaiting");
    expect(state.currentStepId).toBe("select");
    // intake ran, fetch did NOT (gate blocks it)
    expect(toolCalls.map((c) => c.tool)).toEqual(["granola_list_notes"]);
    expect(state.outputs.fetch).toBeUndefined();
  });

  test("map step fans out over an array, collecting outputs", async () => {
    const wf: ProjectedWorkflow = {
      id: "wf",
      order: ["generate"],
      steps: {
        generate: {
          kind: "map",
          id: "generate",
          over: { from: "trigger.payload.formats" },
          child: {
            kind: "reasoning",
            id: "generate.child",
            systemPrompt: "gen",
            source: { provider: "openai-compatible", model: "m" },
            input: { from: "trigger.payload" },
            after: [],
          },
          after: [],
        },
      },
    };
    const { deps, reasoningCalls } = makeDeps();
    const state = await advanceRun(
      wf,
      deps,
      makeState({
        input: { formats: [{ format: "email" }, { format: "blog" }] },
      }),
    );

    expect(reasoningCalls).toHaveLength(2);
    expect(reasoningCalls.map((c) => c.input)).toEqual([
      { format: "email" },
      { format: "blog" },
    ]);
    expect(state.outputs.generate).toHaveLength(2);
    expect(state.status).toBe("completed");
  });

  test("a thrown step fails the run and records the error", async () => {
    const wf: ProjectedWorkflow = {
      id: "wf",
      order: ["boom"],
      steps: {
        boom: {
          kind: "tool",
          id: "boom",
          tool: "bad",
          input: { literal: {} },
          after: [],
        },
      },
    };
    const { deps } = makeDeps({
      toolRunner: {
        run: async () => {
          throw new Error("tool exploded");
        },
      },
    });
    const state = await advanceRun(wf, deps, makeState());
    expect(state.status).toBe("failed");
    expect(state.error).toBe("tool exploded");
  });
});

describe("resumeRun", () => {
  const wf: ProjectedWorkflow = {
    id: "wf",
    order: ["intake", "select", "fetch"],
    steps: {
      intake: {
        kind: "tool",
        id: "intake",
        tool: "granola_list_notes",
        input: { literal: {} },
        after: [],
      },
      select: {
        kind: "gate",
        id: "select",
        signalName: "note-selection",
        after: ["intake"],
      },
      fetch: {
        kind: "tool",
        id: "fetch",
        tool: "granola_get_note",
        input: { from: "steps.select.output" },
        after: ["select"],
      },
    },
  };

  test("applies the gate payload as output and continues from currentStepId", async () => {
    const { deps, toolCalls } = makeDeps();
    let state = await advanceRun(wf, deps, makeState());
    expect(state.status).toBe("awaiting");

    state = await resumeRun(wf, deps, state, "note-selection", {
      noteId: "n42",
    });

    expect(state.outputs.select).toEqual({ noteId: "n42" });
    // fetch ran with the gate output as its input
    expect(toolCalls.find((c) => c.tool === "granola_get_note")?.input).toEqual(
      { noteId: "n42" },
    );
    expect(state.status).toBe("completed");
  });

  test("rejects a resume when not awaiting", async () => {
    const { deps } = makeDeps();
    await expect(
      resumeRun(
        wf,
        deps,
        makeState({ status: "running" }),
        "note-selection",
        {},
      ),
    ).rejects.toThrow(/not awaiting/);
  });

  test("rejects a signal-name mismatch", async () => {
    const { deps } = makeDeps();
    const state = await advanceRun(wf, deps, makeState());
    await expect(
      resumeRun(wf, deps, state, "wrong-signal", {}),
    ).rejects.toThrow(/awaits signal/);
  });

  test("restart mid-gate resumes from the persisted record (state rebuilt, not in-memory)", async () => {
    const { deps: deps1, saves } = makeDeps();
    await advanceRun(wf, deps1, makeState());
    // Simulate a hub restart: reconstruct state purely from the last saved record.
    const persisted = saves[saves.length - 1];
    if (!persisted) throw new Error("expected a persisted save");
    expect(persisted.status).toBe("awaiting");
    const rebuilt: RunState = structuredClone(persisted);

    const { deps: deps2, toolCalls } = makeDeps();
    const resumed = await resumeRun(wf, deps2, rebuilt, "note-selection", {
      noteId: "after-restart",
    });

    expect(resumed.status).toBe("completed");
    expect(toolCalls.find((c) => c.tool === "granola_get_note")?.input).toEqual(
      {
        noteId: "after-restart",
      },
    );
  });
});
