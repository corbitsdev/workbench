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

describe("exa-topic-watch", () => {
  test("exports kind, label, and schedule intake fields", () => {
    expect(kind).toBe("exa-topic-watch");
    expect(label).toBe("Web topic watch");
    expect(INTAKE_FIELDS.map((f) => f.name)).toEqual(["topic"]);
  });

  test("gates on intake, fetches via exa_search, digests, formats, persists", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "exa-topic-watch-fetch": {
        content: [{ url: "https://example.com", title: "Hit" }],
      },
      "exa-topic-watch-digest": { reply: "Digest body" },
      "exa-topic-watch-document": {
        content: { title: "AI agents", body: "Digest body" },
      },
      "exa-topic-watch-persist": { artifactId: "art_1" },
    });
    const run = runLocal(workflow, { invokeStep: invoker });
    await run.signal("intake", { topic: "AI agents" });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const ids = ran.map((r) => r.id);
    expect(ids).toEqual([
      "exa-topic-watch-fetch",
      "exa-topic-watch-digest",
      "exa-topic-watch-document",
      "exa-topic-watch-persist",
    ]);

    const fetchStep = workflow.steps.fetch as {
      agent: { tags?: Record<string, string> };
    };
    expect(fetchStep.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(fetchStep.agent.tags?.[STEP_TOOL_TAG]).toContain("exa_search");

    const persist = workflow.steps.persist as {
      agent: { tags?: Record<string, string> };
    };
    expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain("write_artifact");
  });
});
