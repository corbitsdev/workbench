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
  PREPARE_SEARCH_HANDLER,
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
  calls: Record<string, unknown>[],
): (ref: string) => ActionHandler {
  return (ref: string): ActionHandler => {
    return async (input): Promise<unknown> => {
      calls.push({ ref, input });
      return outputs[ref] ?? null;
    };
  };
}

describe("exa-topic-watch", () => {
  test("exports kind, label, and schedule intake fields", () => {
    expect(kind).toBe("exa-topic-watch");
    expect(label).toBe("Web topic watch");
    expect(INTAKE_FIELDS.map((f) => f.name)).toEqual(["topic"]);
  });

  test("prepare-search is a native action renaming intake's topic to exa_search's query arg via a workflow-owned tool", () => {
    const prepareSearch = actionPrimitive("prepare-search");
    expect(prepareSearch.handler).toBe(PREPARE_SEARCH_HANDLER);
    expect(PREPARE_SEARCH_HANDLER).toBe(
      "@workbench/tools-exa-topic-watch/core:exa_topic_watch_prepare_search",
    );
    expect(prepareSearch.input).toEqual({
      project: { from: "steps.intake.output" },
      fields: ["topic"],
    });
    expect(prepareSearch.effect).toEqual({
      requires: [PREPARE_SEARCH_HANDLER],
    });
    expect(prepareSearch.after).toEqual(["intake"]);
  });

  test("fetch is a native action passthrough dispatching exa_search on prepare-search's renamed query", () => {
    const fetch = actionPrimitive("fetch");
    expect(fetch.handler).toBe(EXA_SEARCH_HANDLER);
    expect(EXA_SEARCH_HANDLER).toBe("@workbench/tools-exa/exa:exa_search");
    expect(fetch.input).toEqual({
      from: "steps.prepare-search.output.content",
    });
    expect(fetch.effect).toEqual({ requires: [EXA_SEARCH_HANDLER] });
    expect(fetch.after).toEqual(["prepare-search"]);
  });

  test("document is a native action pairing intake's topic with digest's reply verbatim", () => {
    const document = actionPrimitive("document");
    expect(document.handler).toBe(FORMAT_REPORT_DOCUMENT_HANDLER);
    expect(FORMAT_REPORT_DOCUMENT_HANDLER).toBe(
      "@workbench/tools-last30days/core:last30days_format_report_document",
    );
    expect(document.input).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.digest.output" },
      ],
    });
    expect(document.effect).toEqual({
      requires: [FORMAT_REPORT_DOCUMENT_HANDLER],
    });
    expect(document.after).toEqual(["digest"]);
  });

  test("persist is a native action projecting title/body and adding the constant kind/jobLabel", () => {
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
        { literal: { kind: "research", jobLabel: label } },
      ],
    });
    expect(persist.effect).toEqual({ requires: [WRITE_ARTIFACT_HANDLER] });
    expect(persist.after).toEqual(["document"]);
  });

  test("gates on intake, renames+fetches via native actions, digests, then dispatches document/persist as native actions", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "exa-topic-watch-digest": { reply: "Digest body" },
    });
    const actionCalls: Record<string, unknown>[] = [];
    const actionResolver = makeActionResolver(
      {
        [PREPARE_SEARCH_HANDLER]: { content: { query: "AI agents" } },
        [EXA_SEARCH_HANDLER]: {
          content: [{ url: "https://example.com", title: "Hit" }],
        },
        [FORMAT_REPORT_DOCUMENT_HANDLER]: {
          content: { title: "AI agents", body: "Digest body" },
        },
        [WRITE_ARTIFACT_HANDLER]: { artifactId: "art_1" },
      },
      actionCalls,
    );

    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver,
    });
    await run.signal("intake", { topic: "AI agents" });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    expect(ran.map((r) => r.id)).toEqual(["exa-topic-watch-digest"]);
    expect(actionCalls.map((c) => c.ref)).toEqual([
      PREPARE_SEARCH_HANDLER,
      EXA_SEARCH_HANDLER,
      FORMAT_REPORT_DOCUMENT_HANDLER,
      WRITE_ARTIFACT_HANDLER,
    ]);
  });
});
