/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { ActionHandler } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  FORMAT_DIGEST_DOCUMENT_HANDLER,
  INTAKE_FIELDS,
  kind,
  label,
  REDDIT_SUBREDDIT_SEARCH_HANDLER,
  WRITE_ARTIFACT_HANDLER,
  workflow,
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
): {
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

  test("fetch is a native action calling reddit_subreddit_search, merging intake with a fixed sort literal", () => {
    const fetchStep = actionPrimitive("fetch");
    expect(fetchStep.handler).toBe(REDDIT_SUBREDDIT_SEARCH_HANDLER);
    expect(REDDIT_SUBREDDIT_SEARCH_HANDLER).toBe(
      "@workbench/tools-reddit/reddit:reddit_subreddit_search",
    );
    expect(fetchStep.input).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { literal: { sort: "relevance" } },
      ],
    });
    expect(fetchStep.effect).toEqual({
      requires: [REDDIT_SUBREDDIT_SEARCH_HANDLER],
    });
  });

  test("persist is a native action calling write_artifact, merging document's { title, body } with fixed kind/jobLabel literals", () => {
    const persistStep = actionPrimitive("persist");
    expect(persistStep.handler).toBe(WRITE_ARTIFACT_HANDLER);
    expect(WRITE_ARTIFACT_HANDLER).toBe(
      "@workbench/tools-artifact/artifact:write_artifact",
    );
    expect(persistStep.input).toEqual({
      merge: [
        { from: "steps.document.output.content" },
        { literal: { kind: "research", jobLabel: label } },
      ],
    });
    expect(persistStep.effect).toEqual({
      requires: [WRITE_ARTIFACT_HANDLER],
    });
  });

  test("document is a native action calling reddit_opportunity_watch_format_digest_document, merging intake's query with digest's reply", () => {
    // reddit_opportunity_watch_format_digest_document is this workflow's own
    // tool (packaged in @workbench/tools-reddit-opportunity-watch, shipped
    // alongside this workflow definition) — it takes `query` verbatim, so
    // intake's `query` (also consumed as-is by reddit_subreddit_search) and
    // digest's `reply` merge straight through with no rename, and the
    // shared, multi-caller last30days_format_report_document (which takes
    // `topic`) is left untouched.
    const documentStep = actionPrimitive("document");
    expect(documentStep.handler).toBe(FORMAT_DIGEST_DOCUMENT_HANDLER);
    expect(FORMAT_DIGEST_DOCUMENT_HANDLER).toBe(
      "@workbench/tools-reddit-opportunity-watch/core:reddit_opportunity_watch_format_digest_document",
    );
    expect(documentStep.input).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.digest.output" },
      ],
    });
    expect(documentStep.effect).toEqual({
      requires: [FORMAT_DIGEST_DOCUMENT_HANDLER],
    });
  });

  test("gates on intake, fetches via reddit_subreddit_search, digests, formats, persists (real runtime)", async () => {
    const { invoker, ran: stepRan } = makeRecordingInvoker({
      "reddit-opportunity-watch-digest": { reply: "Digest body" },
    });
    const { resolver, ran: actionRan } = makeActionResolver({
      [REDDIT_SUBREDDIT_SEARCH_HANDLER]: {
        content: [{ url: "https://reddit.com/r/x", title: "post" }],
      },
      [FORMAT_DIGEST_DOCUMENT_HANDLER]: {
        content: { title: "devops hiring", body: "Digest body" },
      },
      [WRITE_ARTIFACT_HANDLER]: { artifactId: "art_1" },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });
    await run.signal("intake", {
      subreddit: "devops",
      query: "devops hiring",
      timeframe: "week",
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    // fetch (action) ran first with the merged sort literal...
    expect(actionRan[0]?.ref).toBe(REDDIT_SUBREDDIT_SEARCH_HANDLER);
    expect(actionRan[0]?.input).toEqual({
      subreddit: "devops",
      query: "devops hiring",
      timeframe: "week",
      sort: "relevance",
    });

    // ...then digest ran as the sole agent step...
    expect(stepRan.map((r) => r.id)).toEqual(["reddit-opportunity-watch-digest"]);

    // ...then document (action) ran, merging intake's query with digest's reply...
    expect(actionRan[1]?.ref).toBe(FORMAT_DIGEST_DOCUMENT_HANDLER);
    expect(actionRan[1]?.input).toEqual({
      subreddit: "devops",
      query: "devops hiring",
      timeframe: "week",
      reply: "Digest body",
    });

    // ...then persist (action) ran last, with document's { title, body }
    // verbatim plus the fixed kind/jobLabel literals — no reshape step.
    expect(actionRan[2]?.ref).toBe(WRITE_ARTIFACT_HANDLER);
    expect(actionRan[2]?.input).toEqual({
      title: "devops hiring",
      body: "Digest body",
      kind: "research",
      jobLabel: label,
    });
  });
});
