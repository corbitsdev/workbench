import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
} from "@workbench/agents";

import { workflow } from "./index";

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

function mapPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "map") {
    throw new Error(
      `expected map primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
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
  inputUrl: "https://example.com",
  brandName: "Acme",
};

const REVIEW_PAYLOAD = {
  keywords: ["observability"],
  subreddits: ["devops"],
  competitors: [],
  businessContext: "Acme sells observability tooling.",
};

const SELECTION_PAYLOAD = {
  selected: [
    {
      id: "opp-1",
      title: "Anyone using X for tracing?",
      subreddit: "devops",
      signal: "buying-signal" as const,
      detail: "Active buying-intent thread.",
    },
  ],
};

describe("reddit-opportunity-scanner native workflow", () => {
  test("runs the full restored flow: intake → scrape → analyze → review → scan → selection → persist", async () => {
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
    const scanReply = JSON.stringify({
      opportunities: [
        {
          id: "opp-1",
          title: "Anyone using X for tracing?",
          subreddit: "devops",
          signal: "buying-signal",
          detail: "Active buying-intent thread.",
        },
      ],
    });

    const { invoker, ran } = makeRecordingInvoker({
      "reddit-opp-scrape": { content: '{"markdown":"site text"}' },
      "reddit-opp-analyze": AGENT_REPLY(analyzeReply),
      "reddit-opportunity-scan": AGENT_REPLY(scanReply),
      "reddit-opp-persist-item": { artifactId: "art_1" },
    });

    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("intake", INTAKE_PAYLOAD);
    await run.signal("recommendation-review", REVIEW_PAYLOAD);
    await run.signal("opportunity-selection", SELECTION_PAYLOAD);

    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");

    const ranIds = ran.map((r) => r.id);
    // Ordered chain: scrape → analyze → scan → persist (one per selected item).
    expect(ranIds).toEqual([
      "reddit-opp-scrape",
      "reddit-opp-analyze",
      "reddit-opportunity-scan",
      "reddit-opp-persist-item",
    ]);

    const signalNames = result.events
      .filter((e) => e.kind === "SignalReceived")
      .map((e) => (e as { signalName: string }).signalName);
    expect(signalNames).toContain("intake");
    expect(signalNames).toContain("recommendation-review");
    expect(signalNames).toContain("opportunity-selection");
  });

  test("scan step receives the approved review output as input", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "reddit-opp-scrape": { content: "{}" },
      "reddit-opp-analyze": AGENT_REPLY("{}"),
      "reddit-opportunity-scan": AGENT_REPLY(
        JSON.stringify({ opportunities: [] }),
      ),
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("intake", INTAKE_PAYLOAD);
    await run.signal("recommendation-review", REVIEW_PAYLOAD);
    await run.signal("opportunity-selection", { selected: [] });
    await run.complete;

    const scanRun = ran.find((r) => r.id === "reddit-opportunity-scan");
    expect(scanRun?.input).toEqual(REVIEW_PAYLOAD);
  });

  test("intake gates the run before scrape", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "reddit-opp-scrape": { content: "{}" },
      "reddit-opp-analyze": AGENT_REPLY("{}"),
      "reddit-opportunity-scan": AGENT_REPLY(
        JSON.stringify({ opportunities: [] }),
      ),
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    // No signal sent yet: scrape must not have run.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(ran.some((r) => r.id === "reddit-opp-scrape")).toBe(false);

    await run.signal("intake", INTAKE_PAYLOAD);
    await run.signal("recommendation-review", REVIEW_PAYLOAD);
    await run.signal("opportunity-selection", { selected: [] });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
  });

  test("review gates the run before scan", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "reddit-opp-scrape": { content: "{}" },
      "reddit-opp-analyze": AGENT_REPLY("{}"),
      "reddit-opportunity-scan": AGENT_REPLY(
        JSON.stringify({ opportunities: [] }),
      ),
    });
    const run = runLocal(workflow, { invokeStep: invoker });

    await run.signal("intake", INTAKE_PAYLOAD);

    // Wait for analyze to complete, then confirm scan is still gated on review.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (ran.some((r) => r.id === "reddit-opp-analyze")) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });
    expect(ran.some((r) => r.id === "reddit-opportunity-scan")).toBe(false);

    await run.signal("recommendation-review", REVIEW_PAYLOAD);
    await run.signal("opportunity-selection", { selected: [] });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
  });

  test("scrape is a deterministic firecrawl_scrape step mapping inputUrl → url", () => {
    const scrape = stepPrimitive("scrape");
    expect(scrape.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(scrape.agent.tags?.[STEP_TOOL_TAG]).toContain("firecrawl_scrape");
    expect(scrape.agent.inference.sources).toEqual([]);
    expect(scrape.input).toEqual({ from: "steps.intake.output" });
    const argMap = scrape.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMap === undefined) throw new Error("expected argMap on scrape");
    expect(JSON.parse(argMap)).toEqual({ url: { from: "inputUrl" } });
  });

  test("analyze is an inline-inference step with a real prompt and no tools", () => {
    const analyze = stepPrimitive("analyze");
    expect(analyze.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(analyze.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(analyze.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(analyze.agent.capabilities).toEqual([]);
    expect(analyze.agent.inference.sources).toEqual([]);
    expect(analyze.input).toEqual({
      merge: [{ from: "steps.scrape.output" }, { from: "steps.intake.output" }],
    });
  });

  test("scan is a deployed tool-using agent step with the reddit capabilities and an inference source", () => {
    const scan = stepPrimitive("scan");
    // Not a deterministic or inline marker — a genuine tool-capable reasoning step.
    expect(scan.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(scan.agent.systemPrompt.length).toBeGreaterThan(0);
    // capabilities are canonicalized to the prefixed runtime name.
    expect(
      scan.agent.capabilities.some((c) => c.endsWith("reddit_search")),
    ).toBe(true);
    expect(
      scan.agent.capabilities.some((c) =>
        c.endsWith("reddit_subreddit_search"),
      ),
    ).toBe(true);
    expect(scan.agent.inference.sources.length).toBeGreaterThan(0);
    expect(scan.input).toEqual({ from: "steps.review.output" });
    expect(scan.after).toContain("review");
  });

  test("review and selection are awaitSignal gates after analyze and scan", () => {
    const review = awaitSignalPrimitive("review");
    expect(review.name).toBe("recommendation-review");
    expect(review.after).toContain("analyze");

    const selection = awaitSignalPrimitive("selection");
    expect(selection.name).toBe("opportunity-selection");
    expect(selection.after).toContain("scan");
  });

  test("persist is a map of deterministic artifact_create steps over selected", () => {
    const persist = mapPrimitive("persist");
    expect(persist.over).toEqual({ from: "steps.selection.output.selected" });
    const inner = persist.step;
    expect(inner.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(inner.agent.tags?.[STEP_TOOL_TAG]).toContain("artifact_create");
    expect(inner.agent.inference.sources).toEqual([]);
    const argMap = inner.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMap === undefined)
      throw new Error("expected argMap on persist inner step");
    expect(JSON.parse(argMap)).toEqual({
      title: { from: "title" },
      kind: { literal: "document" },
      content: { from: "detail" },
    });
  });
});
