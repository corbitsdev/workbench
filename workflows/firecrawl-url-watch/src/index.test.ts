/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { ActionHandler, StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  FIRECRAWL_SCRAPE_HANDLER,
  FORMAT_DOCUMENT_HANDLER,
  INTAKE_FIELDS,
  WRITE_ARTIFACT_HANDLER,
  kind,
  label,
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

describe("firecrawl-url-watch", () => {
  test("exports kind, label, and schedule intake fields", () => {
    expect(kind).toBe("firecrawl-url-watch");
    expect(label).toBe("Website URL watch");
    expect(INTAKE_FIELDS.map((f) => f.name)).toEqual(["url", "focus"]);
  });

  test("fetch is a native action calling firecrawl_scrape with intake's url passed through verbatim plus a literal onlyMainContent", () => {
    const fetch = actionPrimitive("fetch");
    expect(fetch.handler).toBe(FIRECRAWL_SCRAPE_HANDLER);
    expect(FIRECRAWL_SCRAPE_HANDLER).toBe(
      "@workbench/tools-firecrawl/firecrawl:firecrawl_scrape",
    );
    expect(fetch.input).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { literal: { onlyMainContent: true } },
      ],
    });
    expect(fetch.effect).toEqual({ requires: [FIRECRAWL_SCRAPE_HANDLER] });
  });

  test("persist is a native action merging document's {title, body} content with a literal kind/jobLabel", () => {
    const persist = actionPrimitive("persist");
    expect(persist.handler).toBe(WRITE_ARTIFACT_HANDLER);
    expect(WRITE_ARTIFACT_HANDLER).toBe(
      "@workbench/tools-artifact/artifact:write_artifact",
    );
    expect(persist.after).toEqual(["document"]);
    expect(persist.input).toEqual({
      merge: [
        { from: "steps.document.output.content" },
        { literal: { kind: "research", jobLabel: label } },
      ],
    });
    expect(persist.effect).toEqual({ requires: [WRITE_ARTIFACT_HANDLER] });
  });

  test("document is a native action calling this workflow's own firecrawl_url_watch_format_document tool with intake's url and digest's reply passed through verbatim", () => {
    const document = actionPrimitive("document");
    expect(document.handler).toBe(FORMAT_DOCUMENT_HANDLER);
    expect(FORMAT_DOCUMENT_HANDLER).toBe(
      "@workbench/tools-firecrawl-url-watch/core:firecrawl_url_watch_format_document",
    );
    expect(document.input).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.digest.output" },
      ],
    });
    expect(document.after).toEqual(["digest"]);
    expect(document.effect).toEqual({ requires: [FORMAT_DOCUMENT_HANDLER] });
  });

  test("gates on intake, scrapes/digests/formats/persists entirely via native actions and agent steps — no deterministicToolStep/argMap anywhere", async () => {
    const { invoker, ran: agentRan } = makeRecordingInvoker({
      "firecrawl-url-watch-digest": { reply: "Digest body" },
    });
    const { resolver, ran: actionRan } = makeActionResolver({
      [FIRECRAWL_SCRAPE_HANDLER]: {
        content: JSON.stringify({
          success: true,
          data: { markdown: "# Hello" },
        }),
      },
      [FORMAT_DOCUMENT_HANDLER]: {
        content: {
          title: "https://example.com/pricing",
          body: "Digest body",
        },
      },
      [WRITE_ARTIFACT_HANDLER]: { artifactId: "art_1" },
    });
    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });
    await run.signal("intake", {
      url: "https://example.com/pricing",
      focus: "pricing",
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    expect(actionRan[0]?.ref).toBe(FIRECRAWL_SCRAPE_HANDLER);
    // No argMap/reshape on the fetch action — intake's url/focus ride along
    // verbatim, merged with the literal onlyMainContent flag.
    expect(actionRan[0]?.input).toEqual({
      url: "https://example.com/pricing",
      focus: "pricing",
      onlyMainContent: true,
    });

    expect(agentRan.map((r) => r.id)).toEqual(["firecrawl-url-watch-digest"]);

    expect(actionRan[1]?.ref).toBe(FORMAT_DOCUMENT_HANDLER);
    expect(actionRan[1]?.input).toEqual({
      url: "https://example.com/pricing",
      focus: "pricing",
      reply: "Digest body",
    });

    expect(actionRan[2]?.ref).toBe(WRITE_ARTIFACT_HANDLER);
    expect(actionRan[2]?.input).toEqual({
      title: "https://example.com/pricing",
      body: "Digest body",
      kind: "research",
      jobLabel: label,
    });
  });
});
