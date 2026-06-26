import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
  STEP_NONFATAL_TAG,
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
  LLM_WRITER_MODEL,
} from "@workbench/agents";

import { workflow } from "./index";
import { buildGroundingSystemPrompt } from "./prompts";

// Bluesky is disabled (CL-2401): its search API fails on every run, and a
// failed source step flips the whole run to RunFailed. It stays out of the
// chain until the auth path is fixed.
const SOURCE_STEP_IDS = [
  "hackernews",
  "github",
  "web",
  "reddit",
  "x",
  "youtube",
  "polymarket",
] as const;

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

describe("last30days-research native workflow", () => {
  test("gates on intake, fans out sources, briefs, writes, then persists", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "last30days-ground": { reply: "{}" },
      "last30days-ground-queries": {
        content: {
          hackernews: "q",
          github: "q",
          web: "q",
          reddit: "q",
          x: "q",
          youtube: "q",
          polymarket: "q",
        },
      },
      "last30days-build-brief": { content: '{"topic":"AI coding tools"}' },
      "last30days-write-report": {
        reply: "What I learned about AI coding tools:",
      },
      "last30days-persist-artifact": { artifactId: "art_1" },
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("intake", {
      topic: "AI coding tools",
      query: "AI coding tools",
      days: 30,
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ranIds = ran.map((r) => r.id);
    // Grounding runs before any source so each fan-out gets a tailored query.
    expect(ranIds).toContain("last30days-ground");
    expect(ranIds).toContain("last30days-ground-queries");
    for (const source of SOURCE_STEP_IDS) {
      expect(ranIds).toContain(`last30days-fetch-${source}`);
    }
    expect(ranIds).toContain("last30days-build-brief");
    expect(ranIds).toContain("last30days-write-report");
    expect(ranIds).toContain("last30days-persist-artifact");

    // Removed decorative/dead steps must not run.
    expect(ranIds).not.toContain("last30days-extract-entities");
    expect(ranIds).not.toContain("last30days-validate-report");
    // Bluesky is disabled (CL-2401) — its step must not run.
    expect(ranIds).not.toContain("last30days-fetch-bluesky");

    for (const source of SOURCE_STEP_IDS) {
      expect(ranIds).toContain(`last30days-fetch-${source}`);
    }
    expect(ranIds.at(-1)).toBe("last30days-persist-artifact");
  });

  test("sources are deterministic tool steps chained serially after grounding", () => {
    // Serial chain (CL-2314 mitigation): groundQueries -> hackernews -> github ->
    // ... -> youtube -> polymarket. The chain is load-bearing — a parallel fan-out
    // races the retry scheduler on the run event log's single-writer seq guard.
    // Each source must depend on exactly its predecessor so no two source bodies
    // are ever in flight at once.
    const expectedPredecessor: Record<
      (typeof SOURCE_STEP_IDS)[number],
      string
    > = {
      hackernews: "groundQueries",
      github: "hackernews",
      web: "github",
      reddit: "web",
      x: "reddit",
      youtube: "x",
      polymarket: "youtube",
    };
    for (const source of SOURCE_STEP_IDS) {
      const step = workflow.steps[source];
      if (step === undefined || step.kind !== "step") {
        throw new Error(`expected a step primitive for ${source}`);
      }
      expect(step.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
      expect(step.after).toEqual([expectedPredecessor[source]]);
    }
  });

  test("each source pulls its own tailored query and that key exists in the grounding prompt", () => {
    // Drift guard: a source's argMap query must select its own key off the
    // grounded-queries map, and the grounding prompt must ask for that key — else
    // the source silently falls back to the untailored base query. Catches a
    // source added to the chain but missed in the prompt.
    const groundingPrompt = buildGroundingSystemPrompt();
    for (const source of SOURCE_STEP_IDS) {
      const step = workflow.steps[source];
      if (step === undefined || step.kind !== "step") {
        throw new Error(`expected a step primitive for ${source}`);
      }
      const argMapJson = step.agent.tags?.[STEP_ARGMAP_TAG];
      if (argMapJson === undefined) {
        throw new Error(`expected an argMap on source step ${source}`);
      }
      const argMap = JSON.parse(argMapJson) as { query?: { from?: string } };
      expect(argMap.query?.from).toBe(source);
      expect(groundingPrompt).toContain(`"${source}"`);
    }
  });

  test("every source step is non-fatal so a dead source degrades to a skip, not a RunFailed", () => {
    for (const source of SOURCE_STEP_IDS) {
      const step = workflow.steps[source];
      if (step === undefined || step.kind !== "step") {
        throw new Error(`expected a step primitive for ${source}`);
      }
      expect(step.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
    }
  });

  test("bluesky is disabled — no bluesky source step exists", () => {
    expect(workflow.steps.bluesky).toBeUndefined();
  });

  test("brief and persist stay fatal — a failure there must fail the run", () => {
    for (const id of ["brief", "persist"] as const) {
      const step = workflow.steps[id];
      if (step === undefined || step.kind !== "step") {
        throw new Error(`expected a step primitive for ${id}`);
      }
      expect(step.agent.tags?.[STEP_NONFATAL_TAG]).toBeUndefined();
    }
  });

  test("brief step pins last30days_workflow_brief with a canonical runtime name", () => {
    const brief = workflow.steps.brief;
    if (brief === undefined || brief.kind !== "step") {
      throw new Error("expected a step primitive for brief");
    }
    expect(brief.agent.tags?.[STEP_TOOL_TAG]).toBe(
      "@workbench/tools-last30days/core:last30days_workflow_brief",
    );
  });

  test("grounding fans out before the sources and feeds the per-source query map", () => {
    const ground = workflow.steps.ground;
    if (ground === undefined || ground.kind !== "step") {
      throw new Error("expected a step primitive for ground");
    }
    expect(ground.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(ground.after).toEqual(["intake"]);

    const groundQueries = workflow.steps.groundQueries;
    if (groundQueries === undefined || groundQueries.kind !== "step") {
      throw new Error("expected a step primitive for groundQueries");
    }
    expect(groundQueries.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "last30days_ground_queries",
    );
    expect(groundQueries.after).toEqual(["ground"]);
  });

  test("the write step pins the heavier writer model; grounding/rerank do not", () => {
    const write = workflow.steps.write;
    if (write === undefined || write.kind !== "step") {
      throw new Error("expected a step primitive for write");
    }
    expect(write.agent.inference.sources[0]?.model).toBe(LLM_WRITER_MODEL);

    for (const id of ["ground", "rerank"] as const) {
      const step = workflow.steps[id];
      if (step === undefined || step.kind !== "step") {
        throw new Error(`expected a step primitive for ${id}`);
      }
      // No preference → the deploy default model is pinned for the step.
      expect(step.agent.inference.sources).toEqual([]);
    }
  });

  test("write is an inline-inference step; persist is deterministic and gated on write", () => {
    const write = workflow.steps.write;
    if (write === undefined || write.kind !== "step") {
      throw new Error("expected a step primitive for write");
    }
    expect(write.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(write.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(write.agent.systemPrompt.length).toBeGreaterThan(0);

    const persist = workflow.steps.persist;
    if (persist === undefined || persist.kind !== "step") {
      throw new Error("expected a step primitive for persist");
    }
    expect(persist.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain("write_artifact");
    expect(persist.after).toContain("write");
    expect(persist.after).not.toContain("validate");
  });
});
