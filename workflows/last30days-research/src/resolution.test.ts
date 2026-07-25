import { describe, expect, test } from "bun:test";
import type { ActionHandler } from "@intx/workflow";
import type { StepInvoker } from "@intx/workflow/runtime";
import { evaluateSelector } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import { parseReport } from "@workbench/last30days-core";

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

// CL-2640 confirmed-shapes fixtures. These are the EXACT stored-output shapes
// the real sidecar produces, established empirically from the real code:
//   - a native `action`'s output (ground_queries/entity_queries/collect/brief,
//     all `kind:"full"` or `kind:"string"` tools) is the tool's return
//     verbatim — `action`'s `ctx.perform` returns `result.output` unwrapped
//     (interchange tool.ts:349-353, sidecar action-tool-handler.ts).
//   - the deterministic (`deterministicToolStep`) harness returns the same
//     `{ callId, content }` shape for the still-shimmed best-effort source
//     steps.
//   - an inline inference step stores `{ reply, turn }`
//     (workflow-substrate-factory.ts:1118).
//   - an awaitSignal step stores the signal payload verbatim (run.ts runAwaitSignal).
// CL-4232: each source's query is nested under a `query` key so a source
// step's own per-source path selector already yields `{ query }` — the
// tool's own argument name.
const GROUND_MAP = {
  hackernews: { query: "hn query" },
  github: { query: "gh query" },
  web: { query: "web query" },
  webB: { query: "web query B" },
  webC: { query: "web query C" },
  reddit: { query: "reddit query" },
  x: { query: "x query" },
  youtube: { query: "youtube query" },
  polymarket: { query: "polymarket query" },
};

const ENTITY_MAP = {
  web: { query: "entity web query" },
  reddit: { query: "entity reddit query" },
  x: { query: "entity x query" },
  youtube: { query: "entity youtube query" },
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

const STEP_OUTPUTS: Record<string, unknown> = {
  "last30days-ground": { reply: JSON.stringify(GROUND_MAP) },
  "last30days-entities": { reply: JSON.stringify(ENTITY_MAP) },
  "last30days-curate": { reply: '{"themes":[],"quotes":[]}' },
  "last30days-write-report": {
    reply: "# AI coding tools\n\nThe report body.",
    turn: 1,
  },
};

const ACTION_OUTPUTS: Record<string, unknown> = {
  [GROUND_QUERIES_HANDLER]: { callId: "call_g", content: GROUND_MAP },
  [ENTITY_QUERIES_HANDLER]: { callId: "call_e", content: ENTITY_MAP },
  [COLLECT_HANDLER]: {
    callId: "call_c",
    content: { topic: "AI coding tools", days: 30, items: [] },
  },
  [WORKFLOW_BRIEF_HANDLER]: {
    callId: "call_b",
    content: JSON.stringify(BRIEF_REPORT),
  },
  [FORMAT_REPORT_DOCUMENT_HANDLER]: {
    callId: "call_d",
    content: {
      title: "AI coding tools",
      body: "# AI coding tools\n\nThe report body.",
    },
  },
  [WRITE_ARTIFACT_HANDLER]: { artifactId: "art_1", version: 1 },
};

describe("CL-2640 runtime shape confirmation (real selector resolution)", () => {
  // Empirical ground truth #1 (CL-4232): the deep dotted input selector
  // resolves PAST `.output.content` straight to a single source's nested
  // `{ query }` object — so a source step's `input` (merging that path with a
  // literal `limit`) resolves to the EXACT tool call args, with no separate
  // reshape step in between.
  test("steps.<id>.output.content.<source> resolves that source's { query } object (deep path)", () => {
    const ctx = {
      trigger: { payload: {} },
      steps: {
        groundQueries: { output: ACTION_OUTPUTS[GROUND_QUERIES_HANDLER] },
      },
    };
    const resolved = evaluateSelector(
      { from: "steps.groundQueries.output.content.web" },
      ctx as never,
    );
    expect(resolved).toEqual(GROUND_MAP.web);
    expect(resolved as Record<string, unknown>).toHaveProperty("query");
  });

  test("a source step's merge+literal input resolves directly to { query, limit } — no argMap layer left", () => {
    const ctx = {
      trigger: { payload: {} },
      steps: {
        groundQueries: { output: ACTION_OUTPUTS[GROUND_QUERIES_HANDLER] },
      },
    };
    const resolved = evaluateSelector(
      {
        merge: [
          { from: "steps.groundQueries.output.content.web" },
          { literal: { limit: 25 } },
        ],
      },
      ctx as never,
    );
    expect(resolved).toEqual({ query: "web query", limit: 25 });
  });

  // Empirical ground truth #2: the deterministic document step (CL-4232) pairs
  // the intake topic with the writer's reply into `{ title, body }`, and
  // persist merges that document output with the brief's `content` plus the
  // literal `{ kind, jobLabel }` — no `intake`/`write` fields reach persist
  // directly, only the composed shape.
  test("steps.document.output.content exposes title/body for persist, merged with the brief's content and the literal constants", () => {
    const merged = evaluateSelector(
      {
        merge: [
          { from: "steps.document.output.content" },
          { from: "steps.brief.output" },
          { literal: { kind: "research", jobLabel: "Last 30 days research" } },
        ],
      },
      {
        trigger: { payload: {} },
        steps: {
          document: {
            output: ACTION_OUTPUTS[FORMAT_REPORT_DOCUMENT_HANDLER],
          },
          brief: { output: ACTION_OUTPUTS[WORKFLOW_BRIEF_HANDLER] },
        },
      } as never,
    ) as Record<string, unknown>;
    expect(merged).toHaveProperty("title", "AI coding tools");
    expect(merged).toHaveProperty(
      "body",
      "# AI coding tools\n\nThe report body.",
    );
    // The brief tool stores its Report JSON under `content`; the hub
    // write_artifact handler reads exactly this key for rich rendering, so it
    // is present on the merge that feeds persist (the ticket's "dead mapping"
    // claim is false).
    expect(merged).toHaveProperty("content");
    expect(merged).toHaveProperty("kind", "research");
    expect(merged).toHaveProperty("jobLabel", "Last 30 days research");
  });
});

describe("CL-2640 corrected workflow through the real executor", () => {
  test("every source step's input resolves a non-empty query and persist's input is valid write_artifact args — with no argMap reshape layer at all", async () => {
    const resolvedInputs: Record<string, unknown> = {};
    const invoker: StepInvoker = async ({ agent, input }) => {
      resolvedInputs[agent.id] = input;
      return { output: STEP_OUTPUTS[agent.id] ?? null };
    };
    // Several source steps share ONE safe wrapper handler ref (e.g.
    // web/webB/webC/web2 all dispatch `last30days_safe_exa_search`), so each
    // ref's resolved inputs are recorded in call order, not overwritten.
    const resolvedActionInputs: Record<string, unknown> = {};
    const resolvedActionInputsByRef: Record<string, unknown[]> = {};
    const resolver = (ref: string): ActionHandler => {
      return async (input) => {
        resolvedActionInputs[ref] = input;
        (resolvedActionInputsByRef[ref] ??= []).push(input);
        return ACTION_OUTPUTS[ref] ?? null;
      };
    };

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

    // Round 1 + round 2 source steps: each `input` resolved directly to the
    // tool's exact call shape — a non-empty tailored `query` plus a numeric
    // `limit` — with no intermediate argMap reshape to drift from it. Every
    // source now dispatches through its safe wrapper handler ref (a native
    // `action`), not a recorded step-agent invocation; `exa_search` backs
    // four calls (web/webB/webC/web2), `reddit_search`/`x_search`/
    // `youtube_search` back two each (round 1 + round 2), the rest back one.
    const expectedCallCountByHandler: Record<string, number> = {
      [SAFE_EXA_SEARCH_HANDLER]: 4,
      [SAFE_HACKERNEWS_SEARCH_HANDLER]: 1,
      [SAFE_GITHUB_ACTIVITY_HANDLER]: 1,
      [SAFE_REDDIT_SEARCH_HANDLER]: 2,
      [SAFE_X_SEARCH_HANDLER]: 2,
      [SAFE_YOUTUBE_SEARCH_HANDLER]: 2,
      [SAFE_POLYMARKET_ODDS_HANDLER]: 1,
    };
    for (const [handler, expectedCount] of Object.entries(
      expectedCallCountByHandler,
    )) {
      const calls = resolvedActionInputsByRef[handler] ?? [];
      expect(calls).toHaveLength(expectedCount);
      for (const call of calls) {
        const args = call as Record<string, unknown>;
        expect(typeof args.query).toBe("string");
        expect((args.query as string).length).toBeGreaterThan(0);
        expect(typeof args.limit).toBe("number");
      }
    }

    // Persist: the write_artifact args the run's `input` selector produced —
    // directly, with no reshape.
    const persistArgs = resolvedActionInputs[WRITE_ARTIFACT_HANDLER] as
      | Record<string, unknown>
      | undefined;
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
