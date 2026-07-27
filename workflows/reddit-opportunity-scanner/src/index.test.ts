import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import type { ActionHandler } from "@intx/workflow/runlocal";
import { LLM_WRITER_MODEL } from "@workbench/agents";

// The retired `deterministic-tool` authoring kind's tags. Kept as literals
// (not an import from `@workbench/agents`, which no longer exports them) —
// this test only asserts the tags are ABSENT from every native step, proving
// no step regresses onto the deleted mechanism.
const STEP_KIND_TAG = "workbench.stepKind";
const STEP_TOOL_TAG = "workbench.tool";

import {
  COLLECT_SEARCHES_HANDLER,
  FIRECRAWL_SCRAPE_HANDLER,
  PERSIST_ITEMS_HANDLER,
  workflow,
} from "./index";

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

function makeActionResolver(outputs: Record<string, unknown> = {}): {
  resolver: (ref: string) => ActionHandler;
  ran: { ref: string; input: unknown }[];
} {
  const ran: { ref: string; input: unknown }[] = [];
  const resolver = (ref: string): ActionHandler => {
    return async (input): Promise<unknown> => {
      ran.push({ ref, input });
      return outputs[ref] ?? null;
    };
  };
  return { resolver, ran };
}

function awaitSignalPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "awaitSignal") {
    throw new Error(
      `expected awaitSignal primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

const AGENT_REPLY = (reply: string): { reply: string } => ({ reply });

const INTAKE_PAYLOAD = {
  url: "https://example.com",
  brandName: "Acme",
};

const REVIEW_PAYLOAD = {
  keywords: ["observability"],
  subreddits: ["devops"],
  competitors: [],
  businessContext: "Acme sells observability tooling.",
  searches: [
    {
      subreddit: "devops",
      query: "observability pricing",
      sort: "relevance",
      timeframe: "month",
      limit: 15,
    },
  ],
};

const SELECTION_PAYLOAD = {
  selected: [
    {
      id: "opp-1",
      title: "Anyone using X for tracing?",
      subreddit: "devops",
      signal: "buying-signal" as const,
      whyItMatters: "Active buying-intent thread.",
      content: "## Opportunity\nActive buying-intent thread.",
    },
  ],
};

describe("reddit-opportunity-scanner native workflow", () => {
  test("runs the full guided flow: intake → scrape → analyze → review → collect → curate → selection → persist", async () => {
    const analyzeReply = JSON.stringify({
      whatTheySell: "Observability tooling",
      mainKeywords: ["observability"],
      competitors: [],
      evidence: ["from site"],
      keywords: [
        { label: "observability", reason: "category", confidence: 0.9 },
      ],
      subreddits: [{ label: "devops", reason: "audience", confidence: 0.8 }],
    });
    const curateReply = JSON.stringify({
      opportunities: [
        {
          id: "opp-1",
          title: "Anyone using X for tracing?",
          subreddit: "devops",
          signal: "buying-signal",
          whyItMatters: "Active buying-intent thread.",
          content: "## Opportunity\nActive buying-intent thread.",
        },
      ],
    });

    const { invoker, ran } = makeRecordingInvoker({
      "reddit-opp-analyze": AGENT_REPLY(analyzeReply),
      "reddit-opp-curate": AGENT_REPLY(curateReply),
    });
    const { resolver, ran: actionRan } = makeActionResolver({
      [FIRECRAWL_SCRAPE_HANDLER]: { content: '{"markdown":"site text"}' },
      [COLLECT_SEARCHES_HANDLER]: { results: ["[]"] },
      [PERSIST_ITEMS_HANDLER]: { results: [{ artifactId: "art_1" }] },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });

    await run.signal("intake", INTAKE_PAYLOAD);
    await run.signal("recommendation-review", REVIEW_PAYLOAD);
    await run.signal("opportunity-selection", SELECTION_PAYLOAD);

    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");

    // Ordered chain: scrape → collect (both native actions, in effect order)
    // → persist (native action, batch over all selected items).
    expect(actionRan.map((r) => r.ref)).toEqual([
      FIRECRAWL_SCRAPE_HANDLER,
      COLLECT_SEARCHES_HANDLER,
      PERSIST_ITEMS_HANDLER,
    ]);
    const ranIds = ran.map((r) => r.id);
    expect(ranIds).toEqual(["reddit-opp-analyze", "reddit-opp-curate"]);

    const signalNames = result.events
      .filter((e) => e.kind === "SignalReceived")
      .map((e) => (e as { signalName: string }).signalName);
    expect(signalNames).toContain("intake");
    expect(signalNames).toContain("recommendation-review");
    expect(signalNames).toContain("opportunity-selection");
  });

  test("collect action receives the full review output (including searches) as input", async () => {
    const { invoker } = makeRecordingInvoker({
      "reddit-opp-analyze": AGENT_REPLY("{}"),
      "reddit-opp-curate": AGENT_REPLY(JSON.stringify({ opportunities: [] })),
    });
    const { resolver, ran: actionRan } = makeActionResolver({
      [FIRECRAWL_SCRAPE_HANDLER]: { content: "{}" },
      [COLLECT_SEARCHES_HANDLER]: { results: ["[]"] },
    });
    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });

    await run.signal("intake", INTAKE_PAYLOAD);
    await run.signal("recommendation-review", REVIEW_PAYLOAD);
    await run.signal("opportunity-selection", { selected: [] });
    await run.complete;

    const collectRun = actionRan.find(
      (r) => r.ref === COLLECT_SEARCHES_HANDLER,
    );
    expect(collectRun?.input).toEqual(REVIEW_PAYLOAD);
  });

  test("intake gates the run before scrape", async () => {
    const { invoker } = makeRecordingInvoker({
      "reddit-opp-analyze": AGENT_REPLY("{}"),
      "reddit-opp-curate": AGENT_REPLY(JSON.stringify({ opportunities: [] })),
    });
    const { resolver, ran: actionRan } = makeActionResolver({
      [FIRECRAWL_SCRAPE_HANDLER]: { content: "{}" },
      [COLLECT_SEARCHES_HANDLER]: { results: ["[]"] },
    });
    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });

    // No signal sent yet: scrape must not have run.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(actionRan.some((r) => r.ref === FIRECRAWL_SCRAPE_HANDLER)).toBe(
      false,
    );

    await run.signal("intake", INTAKE_PAYLOAD);
    await run.signal("recommendation-review", REVIEW_PAYLOAD);
    await run.signal("opportunity-selection", { selected: [] });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
  });

  test("review gates the run before collect", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "reddit-opp-analyze": AGENT_REPLY("{}"),
      "reddit-opp-curate": AGENT_REPLY(JSON.stringify({ opportunities: [] })),
    });
    const { resolver, ran: actionRan } = makeActionResolver({
      [FIRECRAWL_SCRAPE_HANDLER]: { content: "{}" },
      [COLLECT_SEARCHES_HANDLER]: { results: ["[]"] },
    });
    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });

    await run.signal("intake", INTAKE_PAYLOAD);

    // Wait for analyze to complete, then confirm collection is still gated on review.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (ran.some((r) => r.id === "reddit-opp-analyze")) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });
    expect(actionRan.some((r) => r.ref === COLLECT_SEARCHES_HANDLER)).toBe(
      false,
    );

    await run.signal("recommendation-review", REVIEW_PAYLOAD);
    await run.signal("opportunity-selection", { selected: [] });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
  });

  test("scrape is a native action calling firecrawl_scrape with intake's url passed through verbatim", () => {
    const scrape = actionPrimitive("scrape");
    expect(scrape.handler).toBe(FIRECRAWL_SCRAPE_HANDLER);
    expect(scrape.input).toEqual({ from: "steps.intake.output" });
    expect(scrape.effect).toEqual({ requires: [FIRECRAWL_SCRAPE_HANDLER] });
  });

  test("analyze is a native reasoning step (agentStep) with a real prompt and no tools", () => {
    const analyze = stepPrimitive("analyze");
    expect(analyze.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(analyze.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(analyze.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(analyze.agent.capabilities).toEqual([]);
    expect(analyze.agent.inference.sources).toEqual([]);
    expect(analyze.input).toEqual({
      merge: [{ from: "steps.scrape.output" }, { from: "steps.intake.output" }],
    });
  });

  test("collect is a native action dispatching the batch collect-searches handler over review.output", () => {
    const collect = actionPrimitive("collect");
    expect(collect.handler).toBe(COLLECT_SEARCHES_HANDLER);
    expect(collect.input).toEqual({ from: "steps.review.output" });
    expect(collect.effect).toEqual({ requires: [COLLECT_SEARCHES_HANDLER] });
  });

  test("curate is a native reasoning step (agentStep) over collected Reddit evidence", () => {
    const curate = stepPrimitive("curate");
    expect(curate.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(curate.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(curate.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(curate.agent.capabilities).toEqual([]);
    // Long-form synthesis (up to 12 markdown briefs): pins the heavier writer
    // model with an explicit maxTokens so the JSON reply doesn't truncate.
    expect(curate.agent.inference.sources[0]?.model).toBe(LLM_WRITER_MODEL);
    expect(curate.agent.inference.sources[0]?.parameters).toEqual({
      maxTokens: 16384,
    });
    // Scoped to the approved plan + collected results only — the heavy scrape
    // markdown and analyze blob are kept out of the curate inference context.
    expect(curate.input).toEqual({
      project: { from: "steps" },
      fields: ["review", "collect"],
    });
    expect(curate.after).toContain("collect");
  });

  test("review and selection are awaitSignal gates after analyze and curate", () => {
    const review = awaitSignalPrimitive("review");
    expect(review.name).toBe("recommendation-review");
    expect(review.after).toContain("analyze");

    const selection = awaitSignalPrimitive("selection");
    expect(selection.name).toBe("opportunity-selection");
    expect(selection.after).toContain("curate");
  });

  test("persist is a native action dispatching the batch persist-items handler over selection.output", () => {
    const persist = actionPrimitive("persist");
    expect(persist.handler).toBe(PERSIST_ITEMS_HANDLER);
    expect(persist.input).toEqual({ from: "steps.selection.output" });
    expect(persist.effect).toEqual({ requires: [PERSIST_ITEMS_HANDLER] });
  });
});
