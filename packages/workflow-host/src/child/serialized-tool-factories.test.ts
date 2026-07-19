// WORKBENCH-LOCAL (CL-3880): a workflow definition that round-trips
// through JSON (hub deploy frame -> sidecar workflow.json -> child)
// loses its function-valued `toolFactories`: JSON.stringify serializes a
// function element in an array as `null`. Upstream's `hashDefinition`
// (`projectAgent`) then dereferences `factory.id` on the null at the
// very first `RunStarted`, killing every triggered run before any tool
// loading. These tests pin the JSON behavior, the crash, and the
// child-side sanitize that restores hashable stubs on load.
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hashDefinition, type WorkflowDefinition } from "@intx/workflow";

import {
  loadWorkflowDefinition,
  type RunWorkflowChildBindings,
} from "./run-child";
import { sanitizeSerializedToolFactories } from "./serialized-tool-factories";

/** An agent with function-valued tool factories, as authored in memory. */
function authoredAgent(id: string): Record<string, unknown> {
  const factory = Object.assign(() => ({ tools: [] }), {
    id: `${id}:tool`,
    requires: [] as readonly string[],
  });
  return {
    id,
    systemPrompt: "prompt",
    toolFactories: [factory],
    capabilities: [],
    inference: { sources: [{ provider: "anthropic", model: "stub-model" }] },
  };
}

function authoredDefinition(): Record<string, unknown> {
  return {
    id: "wf-serialized",
    triggers: [],
    steps: {
      "step-1": {
        kind: "step",
        id: "step-1",
        agent: authoredAgent("agent-1"),
        input: { from: "trigger.payload" },
        drainBehavior: "cancel",
      },
    },
    stepOrder: ["step-1"],
  };
}

function roundTrip(definition: Record<string, unknown>): WorkflowDefinition {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mirrors the production parse-and-cast in loadWorkflowDefinition
  return JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
}

describe("serialized toolFactories", () => {
  test("JSON round-trip turns function factories into null and hashDefinition crashes on them", () => {
    const parsed = roundTrip(authoredDefinition());
    const step = (
      parsed.steps as unknown as Record<
        string,
        { agent: { toolFactories: unknown[] } }
      >
    )["step-1"];
    expect(step).toBeDefined();
    // Pin the JSON behavior this bug rides on: function -> null in arrays.
    expect(step?.agent.toolFactories).toEqual([null]);
    // Pin the production crash: RunStarted's definition hash NPEs.
    expect(() => hashDefinition(parsed)).toThrow(TypeError);
  });

  test("sanitize replaces null entries with hashable stubs across step, map, and loop bodies", () => {
    const authored = {
      id: "wf-shapes",
      triggers: [],
      steps: {
        "step-1": {
          kind: "step",
          id: "step-1",
          agent: authoredAgent("agent-step"),
          input: { from: "trigger.payload" },
          drainBehavior: "cancel",
        },
        "map-1": {
          kind: "map",
          id: "map-1",
          step: {
            kind: "step",
            id: "map-1-body",
            agent: authoredAgent("agent-map"),
            input: { from: "trigger.payload" },
            drainBehavior: "cancel",
          },
          over: { from: "trigger.payload" },
        },
        "loop-1": {
          kind: "loop",
          id: "loop-1",
          body: {
            id: "loop-body",
            triggers: [],
            steps: {
              inner: {
                kind: "step",
                id: "inner",
                agent: authoredAgent("agent-loop"),
                input: { from: "trigger.payload" },
                drainBehavior: "cancel",
              },
            },
            stepOrder: ["inner"],
          },
        },
      },
      stepOrder: ["step-1", "map-1", "loop-1"],
    };
    const parsed = roundTrip(authored);
    sanitizeSerializedToolFactories(
      parsed.steps as unknown as Record<string, unknown>,
    );
    const steps = parsed.steps as unknown as Record<
      string,
      Record<string, unknown>
    >;
    const stepAgent = steps["step-1"]?.["agent"] as {
      toolFactories: { id: string; requires: readonly string[] }[];
    };
    const mapAgent = (steps["map-1"]?.["step"] as Record<string, unknown>)[
      "agent"
    ] as { toolFactories: { id: string }[] };
    const loopBody = steps["loop-1"]?.["body"] as {
      steps: Record<string, { agent: { toolFactories: { id: string }[] } }>;
    };
    expect(stepAgent.toolFactories).toHaveLength(1);
    expect(typeof stepAgent.toolFactories[0]?.id).toBe("string");
    expect(stepAgent.toolFactories[0]?.requires).toEqual([]);
    expect(typeof mapAgent.toolFactories[0]?.id).toBe("string");
    expect(typeof loopBody.steps["inner"]?.agent.toolFactories[0]?.id).toBe(
      "string",
    );
    // The whole sanitized definition must be hashable -- the exact call
    // that crashes in production without the sanitize.
    expect(() => hashDefinition(parsed)).not.toThrow();
  });

  test("sanitize preserves already-serializable {id, requires} entries verbatim", () => {
    const steps: Record<string, unknown> = {
      "step-1": {
        kind: "step",
        id: "step-1",
        agent: {
          id: "agent-1",
          systemPrompt: "prompt",
          toolFactories: [{ id: "pkg:real-tool", requires: ["env"] }, null],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    };
    sanitizeSerializedToolFactories(steps);
    const agent = (steps["step-1"] as Record<string, unknown>)["agent"] as {
      toolFactories: { id: string; requires: readonly string[] }[];
    };
    expect(agent.toolFactories[0]).toEqual({
      id: "pkg:real-tool",
      requires: ["env"],
    });
    expect(typeof agent.toolFactories[1]?.id).toBe("string");
  });

  test("loadWorkflowDefinition returns a hashable definition from a workflow.json carrying null toolFactories", async () => {
    const baseDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "serialized-toolfactories-"),
    );
    const repoDir = path.join(baseDir, "workflow", "workflow-asset");
    await fs.mkdir(repoDir, { recursive: true });
    // Byte-for-byte what the sidecar deploy router materializes after the
    // hub frame round-trip: null where the function factories were.
    await fs.writeFile(
      path.join(repoDir, "workflow.json"),
      JSON.stringify(roundTrip(authoredDefinition())),
    );
    const bindings = {
      substrate: {
        getRepoDir: (repoId: { kind: string; id: string }) =>
          path.join(baseDir, repoId.kind, repoId.id),
      },
      workflowDefinitionRepoId: { kind: "workflow", id: "workflow-asset" },
      workflowDefinitionRef: "refs/heads/main",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- loadWorkflowDefinition reads only the definition-repo bindings
    } as unknown as RunWorkflowChildBindings;
    const definition = await loadWorkflowDefinition(bindings);
    expect(() => hashDefinition(definition)).not.toThrow();
  });
});
