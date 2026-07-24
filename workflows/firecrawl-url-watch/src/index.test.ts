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

describe("firecrawl-url-watch", () => {
  test("exports kind, label, and schedule intake fields", () => {
    expect(kind).toBe("firecrawl-url-watch");
    expect(label).toBe("Website URL watch");
    expect(INTAKE_FIELDS.map((f) => f.name)).toEqual(["url", "focus"]);
  });

  test("gates on intake, scrapes via firecrawl_scrape, digests, formats, persists", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "firecrawl-url-watch-fetch": {
        // stringTool shape — content is a JSON string, not a parsed object
        content: JSON.stringify({
          success: true,
          data: { markdown: "# Hello" },
        }),
      },
      "firecrawl-url-watch-digest": { reply: "Digest body" },
      "firecrawl-url-watch-document": {
        content: {
          title: "https://example.com/pricing",
          body: "Digest body",
        },
      },
      "firecrawl-url-watch-persist": { artifactId: "art_1" },
    });
    const run = runLocal(workflow, { invokeStep: invoker });
    await run.signal("intake", {
      url: "https://example.com/pricing",
      focus: "pricing",
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    expect(ran.map((r) => r.id)).toEqual([
      "firecrawl-url-watch-fetch",
      "firecrawl-url-watch-digest",
      "firecrawl-url-watch-document",
      "firecrawl-url-watch-persist",
    ]);

    const fetchStep = workflow.steps.fetch as {
      agent: { tags?: Record<string, string> };
    };
    expect(fetchStep.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(fetchStep.agent.tags?.[STEP_TOOL_TAG]).toContain("firecrawl_scrape");
  });
});
