import { describe, expect, test } from "bun:test";
import type { ActionHandler } from "@intx/workflow";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import { STEP_KIND_TAG, STEP_TOOL_TAG, LLM_WRITER_MODEL } from "@workbench/agents";

import {
  workflow,
  GROUND_QUERIES_HANDLER,
  ENTITY_QUERIES_HANDLER,
  COLLECT_HANDLER,
  WORKFLOW_BRIEF_HANDLER,
  FORMAT_REPORT_DOCUMENT_HANDLER,
  WRITE_ARTIFACT_HANDLER,
  SAFE_EXA_SEARCH_HANDLER,
  SAFE_HACKERNEWS_SEARCH_HANDLER,
  SAFE_GITHUB_ACTIVITY_HANDLER,
  SAFE_REDDIT_SEARCH_HANDLER,
  SAFE_X_SEARCH_HANDLER,
  SAFE_YOUTUBE_SEARCH_HANDLER,
  SAFE_POLYMARKET_ODDS_HANDLER,
} from "./index";
import { buildGroundingSystemPrompt } from "./prompts";

// Every round-1 source's safe wrapper handler, by source key — the single
// lookup the tests below share instead of a per-source if/else.
const SAFE_HANDLER_BY_SOURCE: Record<string, string> = {
  web: SAFE_EXA_SEARCH_HANDLER,
  webB: SAFE_EXA_SEARCH_HANDLER,
  webC: SAFE_EXA_SEARCH_HANDLER,
  hackernews: SAFE_HACKERNEWS_SEARCH_HANDLER,
  github: SAFE_GITHUB_ACTIVITY_HANDLER,
  reddit: SAFE_REDDIT_SEARCH_HANDLER,
  x: SAFE_X_SEARCH_HANDLER,
  youtube: SAFE_YOUTUBE_SEARCH_HANDLER,
  polymarket: SAFE_POLYMARKET_ODDS_HANDLER,
};

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

// Records each action dispatch by its handler ref and returns a canned output
// — the `action`-primitive counterpart of `makeRecordingInvoker` (no agent, no
// step-tool tags; dispatched via `runLocal`'s `actionResolver`).
function makeRecordingActionResolver(outputs: Record<string, unknown> = {}): {
  resolver: (ref: string) => ActionHandler;
  ran: { handler: string; input: unknown }[];
} {
  const ran: { handler: string; input: unknown }[] = [];
  const resolver = (ref: string): ActionHandler => {
    return async (input) => {
      ran.push({ handler: ref, input });
      return outputs[ref] ?? null;
    };
  };
  return { resolver, ran };
}

function stepPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected step primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

describe("last30days-research native workflow", () => {
  test("gates on intake, fans out sources, briefs, writes, then persists", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "last30days-ground": { reply: "{}" },
      "last30days-entities": {
        reply: '{"web":"q","reddit":"q","x":"q","youtube":"q"}',
      },
      "last30days-curate": { reply: '{"themes":[],"quotes":[]}' },
      "last30days-write-report": {
        reply: "What I learned about AI coding tools:",
      },
    });
    const { resolver, ran: actionsRan } = makeRecordingActionResolver({
      [GROUND_QUERIES_HANDLER]: {
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
      // Every wrapped source dispatches through its safe handler now — the
      // canned output stands in for the wrapper's own JSON-string success
      // envelope (an array of items), never the raw underlying tool.
      [SAFE_EXA_SEARCH_HANDLER]: { content: "[]", isError: false },
      [SAFE_HACKERNEWS_SEARCH_HANDLER]: { content: "[]", isError: false },
      [SAFE_GITHUB_ACTIVITY_HANDLER]: { content: "[]", isError: false },
      [SAFE_REDDIT_SEARCH_HANDLER]: { content: "[]", isError: false },
      [SAFE_X_SEARCH_HANDLER]: { content: "[]", isError: false },
      [SAFE_YOUTUBE_SEARCH_HANDLER]: { content: "[]", isError: false },
      [SAFE_POLYMARKET_ODDS_HANDLER]: { content: "[]", isError: false },
      [ENTITY_QUERIES_HANDLER]: {
        content: {
          web: { query: "q" },
          reddit: { query: "q" },
          x: { query: "q" },
          youtube: { query: "q" },
        },
      },
      [COLLECT_HANDLER]: {
        content: { topic: "AI coding tools", days: 30, items: [] },
      },
      [WORKFLOW_BRIEF_HANDLER]: { content: '{"topic":"AI coding tools"}' },
      [FORMAT_REPORT_DOCUMENT_HANDLER]: {
        content: {
          title: "AI coding tools",
          body: "What I learned about AI coding tools:",
        },
      },
      [WRITE_ARTIFACT_HANDLER]: { artifactId: "art_1" },
    });
    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });

    await run.signal("intake", {
      topic: "AI coding tools",
      query: "AI coding tools",
      days: 30,
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ranIds = ran.map((r) => r.id);
    const actionRefs = actionsRan.map((r) => r.handler);
    // Grounding runs before any source so each fan-out gets a tailored query.
    expect(ranIds).toContain("last30days-ground");
    expect(actionRefs).toContain(GROUND_QUERIES_HANDLER);
    // Every round-1 source now dispatches through its safe wrapper handler
    // (a native `action`, not a recorded step-agent invocation).
    expect(actionRefs).toContain(SAFE_EXA_SEARCH_HANDLER);
    expect(actionRefs).toContain(SAFE_HACKERNEWS_SEARCH_HANDLER);
    expect(actionRefs).toContain(SAFE_GITHUB_ACTIVITY_HANDLER);
    expect(actionRefs).toContain(SAFE_REDDIT_SEARCH_HANDLER);
    expect(actionRefs).toContain(SAFE_X_SEARCH_HANDLER);
    expect(actionRefs).toContain(SAFE_YOUTUBE_SEARCH_HANDLER);
    expect(actionRefs).toContain(SAFE_POLYMARKET_ODDS_HANDLER);
    // Entity-chasing round 2 (CL-2503): extract entities, re-query, then collect
    // + curate before the brief. Round-2 web/reddit/x/youtube share the SAME
    // safe handler as round 1 (one wrapper tool, multiple action steps).
    expect(ranIds).toContain("last30days-entities");
    expect(actionRefs).toContain(ENTITY_QUERIES_HANDLER);
    expect(actionRefs).toContain(COLLECT_HANDLER);
    expect(ranIds).toContain("last30days-curate");
    expect(actionRefs).toContain(WORKFLOW_BRIEF_HANDLER);
    expect(ranIds).toContain("last30days-write-report");
    expect(actionRefs).toContain(FORMAT_REPORT_DOCUMENT_HANDLER);
    expect(actionRefs).toContain(WRITE_ARTIFACT_HANDLER);

    // Removed decorative/dead steps must not run.
    expect(ranIds).not.toContain("last30days-extract-entities");
    expect(ranIds).not.toContain("last30days-validate-report");
    // Bluesky is disabled (CL-2401) — its step must not run.
    expect(ranIds).not.toContain("last30days-fetch-bluesky");

    // Persist is the last thing to run.
    expect(actionRefs.at(-1)).toBe(WRITE_ARTIFACT_HANDLER);
  });

  test("sources are native actions chained serially after grounding, dispatching their safe wrapper handler", () => {
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
      const step = actionPrimitive(source);
      const expectedHandler = SAFE_HANDLER_BY_SOURCE[source];
      if (expectedHandler === undefined) {
        throw new Error(`no safe handler mapped for test source "${source}"`);
      }
      expect(step.handler).toBe(expectedHandler);
      expect(step.after).toEqual([expectedPredecessor[source]]);
    }
  });

  test("each source pulls its own tailored query directly (no argMap) and that key exists in the grounding prompt", () => {
    // Drift guard: a source's input selector must select its own key off the
    // grounded-queries map, and the grounding prompt must ask for that key — else
    // the source silently falls back to the untailored base query. Catches a
    // source added to the chain but missed in the prompt.
    const groundingPrompt = buildGroundingSystemPrompt();
    for (const source of SOURCE_STEP_IDS) {
      const step = actionPrimitive(source);
      // The former per-tool `argMap` (query: { from: "query" }) was a pure
      // identity passthrough — it is gone entirely now. `input` composes the
      // exact tool args directly: the per-source path already yields
      // `{ query }` (CL-4232), merged with the literal `limit`.
      expect(step.input).toEqual({
        merge: [
          { from: `steps.groundQueries.output.content.${source}` },
          { literal: { limit: expect.any(Number) as unknown as number } },
        ],
      });
      expect(groundingPrompt).toContain(`"${source}"`);
    }
  });

  test("every source step is a native action — no nonFatal tag exists to carry (CL-4464)", () => {
    // The `nonFatal` degrade lived on `deterministicToolStep`'s agent tags; a
    // native `action` primitive has no `agent` at all, so there is nothing to
    // tag. Tolerance now lives inside the safe wrapper tool itself (`./tools.ts`).
    for (const source of SOURCE_STEP_IDS) {
      const step = actionPrimitive(source);
      expect("agent" in step).toBe(false);
    }
  });

  test("bluesky is disabled — no bluesky source step exists", () => {
    expect(workflow.steps.bluesky).toBeUndefined();
  });

  test("brief and persist are native actions — fatal by construction (no nonFatal exists for action)", () => {
    for (const id of ["brief", "persist"] as const) {
      const primitive = actionPrimitive(id);
      expect("agent" in primitive).toBe(false);
    }
  });

  test("brief action pins last30days_workflow_brief with a canonical runtime name", () => {
    expect(actionPrimitive("brief").handler).toBe(WORKFLOW_BRIEF_HANDLER);
    expect(actionPrimitive("brief").effect).toEqual({
      requires: [WORKFLOW_BRIEF_HANDLER],
    });
  });

  test("grounding fans out before the sources and feeds the per-source query map", () => {
    const ground = stepPrimitive("ground");
    expect(ground.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(ground.after).toEqual(["intake"]);

    const groundQueries = actionPrimitive("groundQueries");
    expect(groundQueries.handler).toBe(GROUND_QUERIES_HANDLER);
    expect(groundQueries.after).toEqual(["ground"]);
    expect(groundQueries.input).toEqual({
      merge: [{ from: "steps.intake.output" }, { from: "steps.ground.output" }],
    });
  });

  test("the write and curate steps pin the heavier writer model; grounding/entities do not", () => {
    const write = stepPrimitive("write");
    expect(write.agent.inference.sources[0]?.model).toBe(LLM_WRITER_MODEL);
    // The writer ceiling rides on the preferred source's parameters; the deploy
    // lifts it onto the resolved InferenceSource.defaults.maxTokens. 16384 is the
    // fix for the mid-sentence (finish_reason:"length") truncation.
    expect(write.agent.inference.sources[0]?.parameters).toEqual({
      maxTokens: 16384,
    });

    // Curation is genuine editorial judgment on the heavier model (CL-2503),
    // with its own JSON-safe token ceiling.
    const curate = stepPrimitive("curate");
    expect(curate.agent.inference.sources[0]?.model).toBe(LLM_WRITER_MODEL);
    expect(curate.agent.inference.sources[0]?.parameters).toEqual({
      maxTokens: 8192,
    });

    for (const id of ["ground", "entities"] as const) {
      const step = stepPrimitive(id);
      // No preference → the deploy default model is pinned for the step.
      expect(step.agent.inference.sources).toEqual([]);
    }
  });

  test("entity round: entities (inline) → entityQueries (action) → round-2 sources chained serially → collect (action) → curate", () => {
    const entities = stepPrimitive("entities");
    expect(entities.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(entities.after).toEqual(["polymarket"]);

    const entityQueries = actionPrimitive("entityQueries");
    expect(entityQueries.handler).toBe(ENTITY_QUERIES_HANDLER);
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
    const round2SafeHandler: Record<string, string> = {
      web2: SAFE_EXA_SEARCH_HANDLER,
      reddit2: SAFE_REDDIT_SEARCH_HANDLER,
      x2: SAFE_X_SEARCH_HANDLER,
      youtube2: SAFE_YOUTUBE_SEARCH_HANDLER,
    };
    for (const [id, predecessor] of Object.entries(round2Predecessor)) {
      const step = actionPrimitive(id);
      const expectedHandler = round2SafeHandler[id];
      if (expectedHandler === undefined) {
        throw new Error(`no safe handler mapped for test round-2 id "${id}"`);
      }
      expect(step.handler).toBe(expectedHandler);
      expect(step.after).toEqual([predecessor]);
      // No argMap left — the input selector already composes the exact call.
      expect(step.input).toEqual({
        merge: [
          {
            from: `steps.entityQueries.output.content.${round2QueryKey[id]}`,
          },
          { literal: { limit: expect.any(Number) as unknown as number } },
        ],
      });
    }

    const collect = actionPrimitive("collect");
    expect(collect.handler).toBe(COLLECT_HANDLER);
    expect(collect.after).toEqual(["youtube2"]);

    const curate = stepPrimitive("curate");
    expect(curate.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(curate.after).toEqual(["collect"]);

    // The brief now gates on curation, not on a relevance rerank.
    expect(actionPrimitive("brief").after).toEqual(["curate"]);
    expect(workflow.steps.rerank).toBeUndefined();
  });

  test("write is a native reasoning step (agentStep); document/persist are native actions gated on write", () => {
    const write = stepPrimitive("write");
    expect(write.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(write.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(write.agent.systemPrompt.length).toBeGreaterThan(0);

    const document = actionPrimitive("document");
    expect(document.handler).toBe(FORMAT_REPORT_DOCUMENT_HANDLER);
    expect(document.after).toEqual(["write"]);

    const persist = actionPrimitive("persist");
    expect(persist.handler).toBe(WRITE_ARTIFACT_HANDLER);
    expect(persist.after).toEqual(["document"]);
    expect(persist.after).not.toContain("validate");
  });
});
