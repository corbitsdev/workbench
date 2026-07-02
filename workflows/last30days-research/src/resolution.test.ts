import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { evaluateSelector } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  DETERMINISTIC_TOOL_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
} from "@workbench/agents";
import { parseReport } from "@workbench/last30days-core";

import { workflow } from "./index";

// CL-2640 confirmed-shapes fixtures. These are the EXACT stored-output shapes
// the real sidecar produces, established empirically from the real code:
//   - a `kind:"full"` tool (ground_queries/entity_queries) stores its handler
//     return verbatim: `{ callId, content: <object> }` (interchange tool.ts:349).
//   - a `kind:"string"` tool (workflow_brief) is wrapped by the runner as
//     `{ callId, content: <string> }` (interchange tool.ts:352-353).
//   - the deterministic harness returns `{ output: <runner result> }` and the
//     runtime stores `result.output` (interchange run.ts:896,909), so
//     `steps.<id>.output` IS that `{ callId, content }` record — a SINGLE
//     unwrap, never double-wrapped.
//   - an inline inference step stores `{ reply, turn }`
//     (workflow-substrate-factory.ts:1118).
//   - an awaitSignal step stores the signal payload verbatim (run.ts runAwaitSignal).
const GROUND_MAP = {
  hackernews: "hn query",
  github: "gh query",
  web: "web query",
  webB: "web query B",
  webC: "web query C",
  reddit: "reddit query",
  x: "x query",
  youtube: "youtube query",
  polymarket: "polymarket query",
};

const ENTITY_MAP = {
  web: "entity web query",
  reddit: "entity reddit query",
  x: "entity x query",
  youtube: "entity youtube query",
};

// A minimal but schema-valid Report — what last30days_workflow_brief stringifies
// and what the hub write_artifact handler parses back out of `args.content` to
// populate the artifact's rich-render brief + citations (write-artifact.ts:52-63).
const BRIEF_REPORT = {
  topic: "AI coding tools",
  days: 30,
  stats: { sourceCount: 3, itemCount: 0 },
  clusters: [],
  bestTakes: [],
  items: [],
  citations: [],
  generatedAt: "2026-07-01T00:00:00.000Z",
};

const STORED_OUTPUTS: Record<string, unknown> = {
  "last30days-ground": { reply: JSON.stringify(GROUND_MAP) },
  "last30days-ground-queries": { callId: "call_g", content: GROUND_MAP },
  "last30days-entities": { reply: JSON.stringify(ENTITY_MAP) },
  "last30days-entity-queries": { callId: "call_e", content: ENTITY_MAP },
  "last30days-collect": {
    callId: "call_c",
    content: { topic: "AI coding tools", days: 30, items: [] },
  },
  "last30days-curate": { reply: '{"themes":[],"quotes":[]}' },
  "last30days-build-brief": {
    callId: "call_b",
    content: JSON.stringify(BRIEF_REPORT),
  },
  "last30days-write-report": {
    reply: "# AI coding tools\n\nThe report body.",
    turn: 1,
  },
  "last30days-persist-artifact": { artifactId: "art_1", version: 1 },
};

// Mirror of the sidecar's reshapeWithArgMap (step-tool-harness.ts:396-434): a
// `{ literal }` supplies a constant; a `{ from }` requires the named key to be
// present on the evaluated input and throws the exact "field absent" error
// otherwise. Reproducing it here — over the input runLocal really resolved —
// is the seam the CL-2640 prod failure lived in.
function reshapeLikeSidecar(
  toolName: string,
  input: unknown,
  argMapJson: string,
): Record<string, unknown> {
  const argMap = JSON.parse(argMapJson) as Record<
    string,
    { from?: string; literal?: unknown }
  >;
  const record =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const args: Record<string, unknown> = {};
  for (const [argName, spec] of Object.entries(argMap)) {
    if ("literal" in spec) {
      args[argName] = spec.literal;
      continue;
    }
    const from = spec.from as string;
    if (record === undefined || !(from in record)) {
      throw new Error(
        `deterministic step "${toolName}" argMap maps tool arg "${argName}" from input field "${from}", but that field is absent on the evaluated step input`,
      );
    }
    args[argName] = record[from];
  }
  return args;
}

describe("CL-2640 runtime shape confirmation (real selector resolution)", () => {
  // Empirical ground truth #1: the deep dotted input selector resolves PAST
  // `.output` — `steps.<id>.output.content` yields the tool's content object,
  // not the whole `{ callId, content }` record — so the source argMap's
  // top-level source keys line up with the evaluated input.
  test("steps.<id>.output.content resolves the tool's content map (deep path)", () => {
    const ctx = {
      trigger: { payload: {} },
      steps: {
        groundQueries: { output: STORED_OUTPUTS["last30days-ground-queries"] },
      },
    };
    const resolved = evaluateSelector(
      { from: "steps.groundQueries.output.content" },
      ctx as never,
    );
    expect(resolved).toEqual(GROUND_MAP);
    // Every source key is a TOP-LEVEL field on the resolved input — the exact
    // precondition the argMap `{ from: "<source>" }` requires.
    for (const key of Object.keys(GROUND_MAP)) {
      expect(resolved as Record<string, unknown>).toHaveProperty(key);
    }
  });

  // Empirical ground truth #2: the awaitSignal (intake) output exposes `topic`
  // at the top level — NOT nested under a `payload`/`signal` key — so persist's
  // `title: { from: "topic" }` (over a merge that includes intake.output)
  // resolves.
  test("steps.intake.output exposes the signal payload's topic at top level", () => {
    const payload = {
      topic: "AI coding tools",
      query: "AI coding tools",
      days: 30,
    };
    const merged = evaluateSelector(
      {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.brief.output" },
          { from: "steps.write.output" },
        ],
      },
      {
        trigger: { payload },
        steps: {
          intake: { output: payload },
          brief: { output: STORED_OUTPUTS["last30days-build-brief"] },
          write: { output: STORED_OUTPUTS["last30days-write-report"] },
        },
      } as never,
    ) as Record<string, unknown>;
    expect(merged).toHaveProperty("topic", "AI coding tools");
    expect(merged).toHaveProperty("reply");
    // The brief tool stores its Report JSON under `content`; the hub
    // write_artifact handler reads exactly this key for rich rendering, so it
    // is present on the merge that feeds persist (the ticket's "dead mapping"
    // claim is false).
    expect(merged).toHaveProperty("content");
  });
});

describe("CL-2640 corrected workflow through the real executor", () => {
  test("every source-step argMap resolves a non-empty query and persist gets valid write_artifact args", async () => {
    const reshaped: Record<string, Record<string, unknown>> = {};
    const invoker: StepInvoker = async ({ agent, input }) => {
      const kind = agent.tags?.[STEP_KIND_TAG];
      const argMapJson = agent.tags?.[STEP_ARGMAP_TAG];
      if (kind === DETERMINISTIC_TOOL_KIND && argMapJson !== undefined) {
        // Reproduce the sidecar arg-shaping over the REAL resolved input. A
        // dropped `.content` selector or a persist mapping over an absent key
        // throws here exactly as it did in prod (wfr_cb5f9382…).
        reshaped[agent.id] = reshapeLikeSidecar(agent.id, input, argMapJson);
      }
      return { output: STORED_OUTPUTS[agent.id] ?? null };
    };

    const run = runLocal(workflow, { invokeStep: invoker });
    await run.signal("intake", {
      topic: "AI coding tools",
      query: "AI coding tools",
      days: 30,
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    // Round 1 + round 2 source steps: each argMap selected its own tailored,
    // non-empty query off the per-source map.
    const sourceStepIds = [
      "last30days-fetch-web",
      "last30days-fetch-webB",
      "last30days-fetch-webC",
      "last30days-fetch-hackernews",
      "last30days-fetch-github",
      "last30days-fetch-reddit",
      "last30days-fetch-x",
      "last30days-fetch-youtube",
      "last30days-fetch-polymarket",
      "last30days-fetch-web2",
      "last30days-fetch-reddit2",
      "last30days-fetch-x2",
      "last30days-fetch-youtube2",
    ];
    for (const id of sourceStepIds) {
      const args = reshaped[id];
      expect(args).toBeDefined();
      expect(typeof args?.query).toBe("string");
      expect((args?.query as string).length).toBeGreaterThan(0);
      expect(typeof args?.limit).toBe("number");
    }

    // Persist: the write_artifact args the run produced.
    const persistArgs = reshaped["last30days-persist-artifact"];
    expect(persistArgs).toBeDefined();
    expect(persistArgs?.title).toBe("AI coding tools");
    expect(persistArgs?.body).toBe("# AI coding tools\n\nThe report body.");
    expect(persistArgs?.kind).toBe("research");
    expect(persistArgs?.jobLabel).toBe("Last 30 days research");
    // `content` is not dead: it carries the brief's Report JSON, which the hub
    // write_artifact handler parses to populate rich-render brief + citations.
    expect(typeof persistArgs?.content).toBe("string");
    expect(
      parseReport(JSON.parse(persistArgs?.content as string)),
    ).not.toBeNull();
  });
});
