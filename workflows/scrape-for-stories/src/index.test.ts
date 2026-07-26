/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { ActionHandler } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  EXA_SEARCH_HANDLER,
  FORMAT_REPORT_DOCUMENT_HANDLER,
  INTAKE_FIELDS,
  kind,
  label,
  STORY_BUCKET_ARTIFACT_KIND,
  STORY_BUCKET_SOURCE_REF,
  workflow,
  WRITE_ARTIFACT_HANDLER,
} from "./index";

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

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

function makeActionResolver(
  outputs: Record<string, unknown>,
  calls: { ref: string; input: unknown }[],
): (ref: string) => ActionHandler {
  return (ref: string): ActionHandler => {
    return async (input): Promise<unknown> => {
      calls.push({ ref, input });
      return outputs[ref] ?? null;
    };
  };
}

describe("scrape-for-stories", () => {
  test("exports kind, label, artifact kind, and schedule intake fields", () => {
    expect(kind).toBe("scrape-for-stories");
    expect(label).toBe("Scrape for stories");
    expect(STORY_BUCKET_ARTIFACT_KIND).toBe("story-bucket");
    expect(INTAKE_FIELDS.map((f) => f.name)).toEqual(["topics"]);
    expect(INTAKE_FIELDS[0]?.required).toBe(true);
    expect(INTAKE_FIELDS[0]?.inputHint).toBe("string-array");
  });

  test("intake is the only human gate — nothing after it blocks on a person", () => {
    const gates = Object.entries(workflow.steps)
      .filter(([, primitive]) => primitive.kind === "awaitSignal")
      .map(([id]) => id);
    expect(gates).toEqual(["intake"]);
    expect(Object.keys(workflow.steps)).toEqual([
      "intake",
      "collect",
      "document",
      "persist",
    ]);
  });

  test("collect is a tool-using agent step declaring exa_search as a canonical capability", () => {
    const collect = workflow.steps.collect;
    if (collect === undefined || collect.kind !== "step") {
      throw new Error("expected collect to be an agent step");
    }
    expect(collect.agent.id).toBe("scrape-for-stories-collect");
    expect(collect.agent.capabilities).toEqual([EXA_SEARCH_HANDLER]);
    expect(EXA_SEARCH_HANDLER).toBe("@workbench/tools-exa/exa:exa_search");
    // Tool factories are never inlined — the definition is pushed as JSON, so
    // the agent reaches its tools through capabilities only.
    expect(collect.agent.toolFactories).toEqual([]);
    expect(collect.input).toEqual({ from: "steps.intake.output" });
  });

  test("document is a native action pairing a constant bucket title with collect's reply", () => {
    const document = actionPrimitive("document");
    expect(document.handler).toBe(FORMAT_REPORT_DOCUMENT_HANDLER);
    expect(FORMAT_REPORT_DOCUMENT_HANDLER).toBe(
      "@workbench/tools-last30days/core:last30days_format_report_document",
    );
    expect(document.input).toEqual({
      merge: [
        { literal: { topic: "Story bucket" } },
        { project: { from: "steps.collect.output" }, fields: ["reply"] },
      ],
    });
    expect(document.effect).toEqual({
      requires: [FORMAT_REPORT_DOCUMENT_HANDLER],
    });
    expect(document.after).toEqual(["collect"]);
  });

  test("persist is a native action stamping the story-bucket kind and idempotent sourceRef", () => {
    const persist = actionPrimitive("persist");
    expect(persist.handler).toBe(WRITE_ARTIFACT_HANDLER);
    expect(WRITE_ARTIFACT_HANDLER).toBe(
      "@workbench/tools-artifact/artifact:write_artifact",
    );
    expect(persist.input).toEqual({
      merge: [
        {
          project: { from: "steps.document.output.content" },
          fields: ["title", "body"],
        },
        {
          literal: {
            kind: STORY_BUCKET_ARTIFACT_KIND,
            jobLabel: label,
            sourceRef: STORY_BUCKET_SOURCE_REF,
          },
        },
      ],
    });
    expect(persist.effect).toEqual({ requires: [WRITE_ARTIFACT_HANDLER] });
    expect(persist.after).toEqual(["document"]);
  });

  test("runs intake → collect → document → persist and feeds the ranked reply into the persisted artifact", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "scrape-for-stories-collect": {
        reply: "# Story bucket\n- **Headline** — https://example.com",
      },
    });
    const actionCalls: { ref: string; input: unknown }[] = [];
    const actionResolver = makeActionResolver(
      {
        [FORMAT_REPORT_DOCUMENT_HANDLER]: {
          content: {
            title: "Story bucket",
            body: "# Story bucket\n- **Headline** — https://example.com",
          },
        },
        [WRITE_ARTIFACT_HANDLER]: { content: { artifactId: "art_story_1" } },
      },
      actionCalls,
    );

    const run = runLocal(workflow, { invokeStep: invoker, actionResolver });
    await run.signal("intake", {
      topics: ["AI coding agents", "GTM automation"],
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    expect(ran.map((r) => r.id)).toEqual(["scrape-for-stories-collect"]);
    expect(ran[0]?.input).toEqual({
      topics: ["AI coding agents", "GTM automation"],
    });

    expect(actionCalls.map((c) => c.ref)).toEqual([
      FORMAT_REPORT_DOCUMENT_HANDLER,
      WRITE_ARTIFACT_HANDLER,
    ]);
    expect(actionCalls[0]?.input).toEqual({
      topic: "Story bucket",
      reply: "# Story bucket\n- **Headline** — https://example.com",
    });
    expect(actionCalls[1]?.input).toEqual({
      title: "Story bucket",
      body: "# Story bucket\n- **Headline** — https://example.com",
      kind: "story-bucket",
      jobLabel: "Scrape for stories",
      sourceRef: "story-bucket-latest",
    });
  });

  test("a thin week still completes and persists an honest bucket", async () => {
    const thin = "# Story bucket\n\n## Thin / empty\nNo items this week.";
    const { invoker } = makeRecordingInvoker({
      "scrape-for-stories-collect": { reply: thin },
    });
    const actionCalls: { ref: string; input: unknown }[] = [];
    const actionResolver = makeActionResolver(
      {
        [FORMAT_REPORT_DOCUMENT_HANDLER]: {
          content: { title: "Story bucket", body: thin },
        },
        [WRITE_ARTIFACT_HANDLER]: { content: { artifactId: "art_empty" } },
      },
      actionCalls,
    );

    const run = runLocal(workflow, { invokeStep: invoker, actionResolver });
    await run.signal("intake", { topics: ["obscure-query-xyz"] });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
    expect((actionCalls[1]?.input as { body?: string } | undefined)?.body).toBe(
      thin,
    );
  });
});
