/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { ActionHandler } from "@intx/workflow";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  GITHUB_ACTIVITY_HANDLER,
  GITHUB_TOPIC_WATCH_DOCUMENT_HANDLER,
  GITHUB_TOPIC_WATCH_FORMAT_ACTIVITY_QUERY_HANDLER,
  INTAKE_FIELDS,
  WRITE_ARTIFACT_HANDLER,
  kind,
  label,
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

/**
 * Records each action dispatch by its handler ref and returns a canned
 * output, mirroring `makeRecordingInvoker` for the `step` primitive but for
 * native `action` primitives (no agent, no step-tool tags — dispatched via
 * `runLocal`'s `actionResolver`, not `invokeStep`).
 */
function makeRecordingActionResolver(outputs: Record<string, unknown> = {}): {
  resolver: (ref: string) => ActionHandler;
  ran: { handler: string; input: unknown }[];
} {
  const ran: { handler: string; input: unknown }[] = [];
  const resolver = (ref: string): ActionHandler => {
    return async (input) => {
      ran.push({ handler: ref, input });
      return outputs[ref] ?? null;
    };
  };
  return { resolver, ran };
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

describe("github-topic-watch", () => {
  test("exports kind, label, and schedule intake fields", () => {
    expect(kind).toBe("github-topic-watch");
    expect(label).toBe("GitHub topic watch");
    expect(INTAKE_FIELDS.map((f) => f.name)).toEqual(["topic"]);
  });

  test("declares the expected step keys in order", () => {
    expect(Object.keys(workflow.steps)).toEqual([
      "intake",
      "format-query",
      "fetch",
      "digest",
      "document",
      "persist",
    ]);
  });

  test("format-query is a native action renaming intake's topic to github_activity's query, plus a fixed 7-day lookback", () => {
    const formatQuery = actionPrimitive("format-query");
    expect(formatQuery.handler).toBe(
      GITHUB_TOPIC_WATCH_FORMAT_ACTIVITY_QUERY_HANDLER,
    );
    expect(formatQuery.input).toEqual({
      project: { from: "steps.intake.output" },
      fields: ["topic"],
    });
    expect(formatQuery.effect).toEqual({
      requires: [GITHUB_TOPIC_WATCH_FORMAT_ACTIVITY_QUERY_HANDLER],
    });
    expect(formatQuery.after).toEqual(["intake"]);
    expect("agent" in formatQuery).toBe(false);
  });

  test("fetch is a native action, no argMap, and not nonFatal — it's the workflow's sole data source", () => {
    const fetch = actionPrimitive("fetch");
    expect(fetch.handler).toBe(GITHUB_ACTIVITY_HANDLER);
    expect(fetch.input).toEqual({
      from: "steps.format-query.output.content",
    });
    expect(fetch.effect).toEqual({ requires: [GITHUB_ACTIVITY_HANDLER] });
    expect(fetch.after).toEqual(["format-query"]);
    expect("agent" in fetch).toBe(false);
    expect("nonFatal" in fetch).toBe(false);
  });

  test("document is a native action reading intake's topic and digest's reply verbatim — names already match, no argMap", () => {
    const document = actionPrimitive("document");
    expect(document.handler).toBe(GITHUB_TOPIC_WATCH_DOCUMENT_HANDLER);
    expect(document.input).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.digest.output" },
      ],
    });
    expect(document.effect).toEqual({
      requires: [GITHUB_TOPIC_WATCH_DOCUMENT_HANDLER],
    });
    expect(document.after).toEqual(["digest"]);
    expect("agent" in document).toBe(false);
  });

  test("persist is a native action pairing document's content with the fixed research kind/jobLabel", () => {
    const persist = actionPrimitive("persist");
    expect(persist.handler).toBe(WRITE_ARTIFACT_HANDLER);
    expect(persist.input).toEqual({
      merge: [
        { from: "steps.document.output.content" },
        { literal: { kind: "research", jobLabel: label } },
      ],
    });
    expect(persist.effect).toEqual({ requires: [WRITE_ARTIFACT_HANDLER] });
    expect(persist.after).toEqual(["document"]);
    expect("agent" in persist).toBe(false);
  });

  test("gates on intake, shapes the query, fetches via github_activity, digests, formats, persists", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "github-topic-watch-digest": { reply: "Digest body" },
    });
    const { resolver, ran: actionsRan } = makeRecordingActionResolver({
      [GITHUB_TOPIC_WATCH_FORMAT_ACTIVITY_QUERY_HANDLER]: {
        content: { query: "AI agents", days: 7 },
      },
      [GITHUB_ACTIVITY_HANDLER]: {
        content: [{ url: "https://github.com/x/y", title: "repo" }],
      },
      [GITHUB_TOPIC_WATCH_DOCUMENT_HANDLER]: {
        content: { title: "AI agents", body: "Digest body" },
      },
      [WRITE_ARTIFACT_HANDLER]: { content: { artifactId: "art_1" } },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });
    await run.signal("intake", { topic: "AI agents" });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    expect(ran.map((r) => r.id)).toEqual(["github-topic-watch-digest"]);
    const actionRefs = actionsRan.map((r) => r.handler);
    expect(actionRefs).toEqual([
      GITHUB_TOPIC_WATCH_FORMAT_ACTIVITY_QUERY_HANDLER,
      GITHUB_ACTIVITY_HANDLER,
      GITHUB_TOPIC_WATCH_DOCUMENT_HANDLER,
      WRITE_ARTIFACT_HANDLER,
    ]);
    // format-query's selector projected intake's topic verbatim.
    expect(actionsRan[0]?.input).toEqual({ topic: "AI agents" });
    // fetch's selector read format-query's { query, days } content verbatim.
    expect(actionsRan[1]?.input).toEqual({ query: "AI agents", days: 7 });
    // document's selector merged intake's topic with digest's reply verbatim.
    expect(actionsRan[2]?.input).toEqual({
      topic: "AI agents",
      reply: "Digest body",
    });
  });

  test("a failing fetch (github_activity error) fails the run — the sole data source is not nonFatal", async () => {
    const { invoker, ran } = makeRecordingInvoker();
    const { resolver } = makeRecordingActionResolver({
      [GITHUB_TOPIC_WATCH_FORMAT_ACTIVITY_QUERY_HANDLER]: {
        content: { query: "AI agents", days: 7 },
      },
    });
    const failingResolver = (ref: string): ActionHandler => {
      if (ref === GITHUB_ACTIVITY_HANDLER) {
        return async () => {
          throw new Error("GitHub API error: 403 rate limited");
        };
      }
      return resolver(ref);
    };

    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: failingResolver,
    });
    await run.signal("intake", { topic: "AI agents" });
    const result = await run.complete;

    expect(result.terminalStatus).toBe("failed");
    const stepFailed = result.events.find(
      (e) => e.kind === "StepFailed" && e.stepId === "fetch",
    );
    expect(stepFailed).toBeDefined();
    // The run failed before reaching digest — no best-effort degrade.
    expect(ran.map((r) => r.id)).toEqual([]);
  });
});
