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

describe("github-topic-watch", () => {
  test("exports kind, label, and schedule intake fields", () => {
    expect(kind).toBe("github-topic-watch");
    expect(label).toBe("GitHub topic watch");
    expect(INTAKE_FIELDS.map((f) => f.name)).toEqual(["topic"]);
  });

  test("gates on intake, fetches via github_activity, digests, formats, persists", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "github-topic-watch-fetch": {
        content: [{ url: "https://github.com/x/y", title: "repo" }],
      },
      "github-topic-watch-digest": { reply: "Digest body" },
      "github-topic-watch-document": {
        content: { title: "AI agents", body: "Digest body" },
      },
      "github-topic-watch-persist": { artifactId: "art_1" },
    });
    const run = runLocal(workflow, { invokeStep: invoker });
    await run.signal("intake", { topic: "AI agents" });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    expect(ran.map((r) => r.id)).toEqual([
      "github-topic-watch-fetch",
      "github-topic-watch-digest",
      "github-topic-watch-document",
      "github-topic-watch-persist",
    ]);

    const fetchStep = workflow.steps.fetch as {
      agent: { tags?: Record<string, string> };
    };
    expect(fetchStep.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(fetchStep.agent.tags?.[STEP_TOOL_TAG]).toContain("github_activity");
  });
});
