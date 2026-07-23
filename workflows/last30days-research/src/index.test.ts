import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  STEP_ARGMAP_TAG,
  STEP_NONFATAL_TAG,
  DETERMINISTIC_TOOL_KIND,
  LLM_WRITER_MODEL,
} from "@workbench/agents";

import { workflow } from "./index";
import { buildGroundingSystemPrompt } from "./prompts";

// Bluesky is disabled (CL-2401): its search API fails on every run, and a
// failed source step flips the whole run to RunFailed. It stays out of the
// chain until the auth path is fixed.
const SOURCE_STEP_IDS = [
  "web",
  "webB",
  "webC",
  "hackernews",
  "github",
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
          hackernews: { query: "q" },
          github: { query: "q" },
          web: { query: "q" },
          webB: { query: "q" },
          webC: { query: "q" },
          reddit: { query: "q" },
          x: { query: "q" },
          youtube: { query: "q" },
          polymarket: { query: "q" },
        },
      },
      "last30days-entities": {
        reply: '{"web":"q","reddit":"q","x":"q","youtube":"q"}',
      },
      "last30days-entity-queries": {
        content: {
          web: { query: "q" },
          reddit: { query: "q" },
          x: { query: "q" },
          youtube: { query: "q" },
        },
      },
      "last30days-collect": {
        content: { topic: "AI coding tools", days: 30, items: [] },
      },
      "last30days-curate": { reply: '{"themes":[],"quotes":[]}' },
      "last30days-build-brief": { content: '{"topic":"AI coding tools"}' },
      "last30days-write-report": {
        reply: "What I learned about AI coding tools:",
      },
      "last30days-document": {
        content: {
          title: "AI coding tools",
          body: "What I learned about AI coding tools:",
        },
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
    // Entity-chasing round 2 (CL-2503): extract entities, re-query, then collect
    // + curate before the brief.
    expect(ranIds).toContain("last30days-entities");
    expect(ranIds).toContain("last30days-entity-queries");
    for (const id of ["web2", "reddit2", "x2", "youtube2"] as const) {
      expect(ranIds).toContain(`last30days-fetch-${id}`);
    }
    expect(ranIds).toContain("last30days-collect");
    expect(ranIds).toContain("last30days-curate");
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
      web: "groundQueries",
      webB: "web",
      webC: "webB",
      hackernews: "webC",
      github: "hackernews",
      reddit: "github",
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
      // CL-4232: the source's own path selector (`steps.groundQueries.output
      // .content.<source>`) already yields `{ query }` nested under the
      // source's key — the argMap entry is now a plain identity passthrough.
      expect(argMap.query?.from).toBe("query");
      expect(step.input).toEqual({
        from: `steps.groundQueries.output.content.${source}`,
      });
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
    expect(ground.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
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

  test("the write and curate steps pin the heavier writer model; grounding/entities do not", () => {
    const write = workflow.steps.write;
    if (write === undefined || write.kind !== "step") {
      throw new Error("expected a step primitive for write");
    }
    expect(write.agent.inference.sources[0]?.model).toBe(LLM_WRITER_MODEL);
    // The writer ceiling rides on the preferred source's parameters; the deploy
    // lifts it onto the resolved InferenceSource.defaults.maxTokens. 16384 is the
    // fix for the mid-sentence (finish_reason:"length") truncation.
    expect(write.agent.inference.sources[0]?.parameters).toEqual({
      maxTokens: 16384,
    });

    // Curation is genuine editorial judgment on the heavier model (CL-2503),
    // with its own JSON-safe token ceiling.
    const curate = workflow.steps.curate;
    if (curate === undefined || curate.kind !== "step") {
      throw new Error("expected a step primitive for curate");
    }
    expect(curate.agent.inference.sources[0]?.model).toBe(LLM_WRITER_MODEL);
    expect(curate.agent.inference.sources[0]?.parameters).toEqual({
      maxTokens: 8192,
    });

    for (const id of ["ground", "entities"] as const) {
      const step = workflow.steps[id];
      if (step === undefined || step.kind !== "step") {
        throw new Error(`expected a step primitive for ${id}`);
      }
      // No preference → the deploy default model is pinned for the step.
      expect(step.agent.inference.sources).toEqual([]);
    }
  });

  test("entity round: entities (inline) → entityQueries (tool) → round-2 sources chained serially → collect → curate", () => {
    const entities = workflow.steps.entities;
    if (entities === undefined || entities.kind !== "step") {
      throw new Error("expected a step primitive for entities");
    }
    expect(entities.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(entities.after).toEqual(["polymarket"]);

    const entityQueries = workflow.steps.entityQueries;
    if (entityQueries === undefined || entityQueries.kind !== "step") {
      throw new Error("expected a step primitive for entityQueries");
    }
    expect(entityQueries.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "last30days_entity_queries",
    );
    expect(entityQueries.after).toEqual(["entities"]);

    // Round-2 sources chase the discovered entities and must chain serially
    // (CL-2314), starting after entityQueries — never overlapping round 1.
    const round2Predecessor: Record<string, string> = {
      web2: "entityQueries",
      reddit2: "web2",
      x2: "reddit2",
      youtube2: "x2",
    };
    const round2QueryKey: Record<string, string> = {
      web2: "web",
      reddit2: "reddit",
      x2: "x",
      youtube2: "youtube",
    };
    for (const [id, predecessor] of Object.entries(round2Predecessor)) {
      const step = workflow.steps[id];
      if (step === undefined || step.kind !== "step") {
        throw new Error(`expected a step primitive for ${id}`);
      }
      expect(step.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
      expect(step.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
      expect(step.after).toEqual([predecessor]);
      const argMapJson = step.agent.tags?.[STEP_ARGMAP_TAG];
      if (argMapJson === undefined) {
        throw new Error(`expected an argMap on round-2 step ${id}`);
      }
      const argMap = JSON.parse(argMapJson) as { query?: { from?: string } };
      // CL-4232: identity passthrough — the per-source path selector already
      // selects this round's `{ query }` off the entity-queries map.
      expect(argMap.query?.from).toBe("query");
      expect(step.input).toEqual({
        from: `steps.entityQueries.output.content.${round2QueryKey[id]}`,
      });
    }

    const collect = workflow.steps.collect;
    if (collect === undefined || collect.kind !== "step") {
      throw new Error("expected a step primitive for collect");
    }
    expect(collect.agent.tags?.[STEP_TOOL_TAG]).toContain("last30days_collect");
    expect(collect.after).toEqual(["youtube2"]);

    const curate = workflow.steps.curate;
    if (curate === undefined || curate.kind !== "step") {
      throw new Error("expected a step primitive for curate");
    }
    expect(curate.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(curate.after).toEqual(["collect"]);

    // The brief now gates on curation, not on a relevance rerank.
    expect(
      workflow.steps.brief?.kind === "step" && workflow.steps.brief.after,
    ).toEqual(["curate"]);
    expect(workflow.steps.rerank).toBeUndefined();
  });

  test("write is a native reasoning step (agentStep); persist is deterministic and gated on write", () => {
    const write = workflow.steps.write;
    if (write === undefined || write.kind !== "step") {
      throw new Error("expected a step primitive for write");
    }
    expect(write.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(write.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(write.agent.systemPrompt.length).toBeGreaterThan(0);

    const document = workflow.steps.document;
    if (document === undefined || document.kind !== "step") {
      throw new Error("expected a step primitive for document");
    }
    expect(document.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "last30days_format_report_document",
    );
    expect(document.after).toEqual(["write"]);

    const persist = workflow.steps.persist;
    if (persist === undefined || persist.kind !== "step") {
      throw new Error("expected a step primitive for persist");
    }
    expect(persist.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain("write_artifact");
    expect(persist.after).toEqual(["document"]);
    expect(persist.after).not.toContain("validate");
  });
});
