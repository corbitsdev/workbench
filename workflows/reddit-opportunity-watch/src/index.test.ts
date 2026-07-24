/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  DETERMINISTIC_TOOL_KIND,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
} from "@workbench/agents";
import { INTAKE_FIELDS, kind, label, workflow } from "./index";

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

describe("reddit-opportunity-watch", () => {
  test("exports kind, label, and schedule intake fields", () => {
    expect(kind).toBe("reddit-opportunity-watch");
    expect(label).toBe("Reddit opportunity watch");
    expect(INTAKE_FIELDS.map((f) => f.name)).toEqual([
      "subreddit",
      "query",
      "timeframe",
    ]);
  });

  test("gates on intake, fetches via reddit_subreddit_search, digests, formats, persists", async () => {
    // Ensure digest input merges whole step outputs (objects), not array content.
    expect(
      (workflow.steps.digest as { input?: unknown }).input,
    ).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.fetch.output" },
      ],
    });

    const { invoker, ran } = makeRecordingInvoker({
      "reddit-opportunity-watch-fetch": {
        content: [{ url: "https://reddit.com/r/x", title: "post" }],
      },
      "reddit-opportunity-watch-digest": { reply: "Digest body" },
      "reddit-opportunity-watch-document": {
        content: { title: "devops hiring", body: "Digest body" },
      },
      "reddit-opportunity-watch-persist": { artifactId: "art_1" },
    });
    const run = runLocal(workflow, { invokeStep: invoker });
    await run.signal("intake", {
      subreddit: "devops",
      query: "devops hiring",
      timeframe: "week",
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    expect(ran.map((r) => r.id)).toEqual([
      "reddit-opportunity-watch-fetch",
      "reddit-opportunity-watch-digest",
      "reddit-opportunity-watch-document",
      "reddit-opportunity-watch-persist",
    ]);

    const fetchStep = workflow.steps.fetch as {
      agent: { tags?: Record<string, string> };
    };
    expect(fetchStep.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(fetchStep.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "reddit_subreddit_search",
    );
  });
});
