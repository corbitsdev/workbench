import { describe, expect, test } from "bun:test";
import { runLocal } from "@intx/workflow/runlocal";
import type { ActionHandler } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";

import {
  ARTIFACT_LIST_HANDLER,
  BUILD_GENERATE_ITEMS_HANDLER,
  FETCH_SOURCES_HANDLER,
  GRANOLA_LIST_NOTES_HANDLER,
  LIST_ISSUES_HANDLER,
  PERSIST_PIECES_HANDLER,
  PREPARE_OPTIONS_GATE_HANDLER,
  PREPARE_REGENERATE_ITEMS_HANDLER,
  PREPARE_REVIEW_FINAL_GATE_HANDLER,
  PREPARE_REVIEW_GATE_HANDLER,
  PREPARE_SOURCES_GATE_HANDLER,
  kind,
  label,
  workflow,
} from "./index";
import { buildGenerationSystemPrompt, CONTENT_TYPES } from "./prompts";
import {
  parseArtifactList,
  parseGeneratedPieces,
  parseIssueList,
  parseNoteList,
} from "./parse";

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

function mapPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "map") {
    throw new Error(
      `expected map for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

const AGENT_REPLY = (reply: string): { reply: string } => ({ reply });

describe("multi-source-collateral package", () => {
  test("exports kind and label", () => {
    expect(kind).toBe("multi-source-collateral");
    expect(label).toContain("Collateral");
  });

  test("workflow id matches kind", () => {
    expect(workflow.id).toBe(kind);
  });

  test("list-issues is a native action dispatching the tolerant wrapper tool", () => {
    const primitive = actionPrimitive("list-issues");
    expect(primitive.handler).toBe(LIST_ISSUES_HANDLER);
    expect(primitive.input).toEqual({ literal: { first: 50 } });
    // Sibling pins @workbench/tools-linear so the linear credential is
    // allow-listed. Assert the whole canonical string: a wrong package
    // prefix pins nothing and reproduces the silent-403 this guards against.
    expect(primitive.effect).toEqual({
      requires: [
        LIST_ISSUES_HANDLER,
        "@workbench/tools-linear/linear:linear_list_issues",
      ],
    });
  });

  test("list-artifacts is a native action calling artifact_list with a literal limit", () => {
    const primitive = actionPrimitive("list-artifacts");
    expect(primitive.handler).toBe(ARTIFACT_LIST_HANDLER);
    expect(primitive.input).toEqual({ literal: { limit: 50 } });
    expect(primitive.effect).toEqual({ requires: [ARTIFACT_LIST_HANDLER] });
  });

  test("list-notes is a native action calling granola_list_notes with a literal limit", () => {
    const primitive = actionPrimitive("list-notes");
    expect(primitive.handler).toBe(GRANOLA_LIST_NOTES_HANDLER);
    expect(primitive.input).toEqual({ literal: { limit: 30 } });
    expect(primitive.effect).toEqual({
      requires: [GRANOLA_LIST_NOTES_HANDLER],
    });
  });

  test("fetchSources folds the former per-kind maps into one action", () => {
    const primitive = actionPrimitive("fetchSources");
    expect(primitive.handler).toBe(FETCH_SOURCES_HANDLER);
    expect(primitive.input).toEqual({ from: "steps.sources.output" });
  });

  test("action→action selectors read ToolResult.content (production wire shape)", () => {
    expect(actionPrimitive("prepareSourcesGate").input).toEqual({
      merge: [
        { from: "steps.list-artifacts.output.content" },
        { from: "steps.list-notes.output.content" },
        { from: "steps.list-issues.output.content" },
      ],
    });
    expect(actionPrimitive("prepareOptionsGate").input).toEqual({
      from: "steps.fetchSources.output.content",
    });
    expect(actionPrimitive("buildGenerateItems").input).toEqual({
      merge: [
        { from: "steps.fetchSources.output.content" },
        { from: "steps.options.output" },
      ],
    });
    expect(mapPrimitive("generate").over).toEqual({
      from: "steps.buildGenerateItems.output.content.items",
    });
    expect(actionPrimitive("prepareRegenerateItems").input).toEqual({
      merge: [
        { from: "steps.review.output" },
        { from: "steps.fetchSources.output.content" },
      ],
    });
    const regenerateGate = workflow.steps.regenerateGate;
    if (regenerateGate === undefined || regenerateGate.kind !== "gate") {
      throw new Error("expected regenerateGate");
    }
    expect(regenerateGate.when).toEqual({
      from: "steps.prepareRegenerateItems.output.content.shouldRegenerate",
    });
    expect(mapPrimitive("regenerate").over).toEqual({
      from: "steps.prepareRegenerateItems.output.content.regenerateItems",
    });
  });

  test("persist and persist-after-regen both target the folded persist-pieces action", () => {
    expect(actionPrimitive("persist").handler).toBe(PERSIST_PIECES_HANDLER);
    expect(actionPrimitive("persist-after-regen").handler).toBe(
      PERSIST_PIECES_HANDLER,
    );
  });

  test("generate/regenerate maps use inline inference (no tool-dispatch tags)", () => {
    const generate = mapPrimitive("generate");
    const regenerate = mapPrimitive("regenerate");
    expect(generate.step.agent.inference.sources.length).toBe(1);
    expect(regenerate.step.agent.inference.sources.length).toBe(1);
    expect(generate.step.agent.toolFactories).toEqual([]);
    expect(regenerate.step.agent.toolFactories).toEqual([]);
  });

  test("gate handlers reference the committed workflow-owned tool names", () => {
    expect(PREPARE_SOURCES_GATE_HANDLER).toContain(
      "multi_source_collateral_prepare_sources_gate",
    );
    expect(PREPARE_OPTIONS_GATE_HANDLER).toContain(
      "multi_source_collateral_prepare_options_gate",
    );
    expect(PREPARE_REVIEW_GATE_HANDLER).toContain(
      "multi_source_collateral_prepare_review_gate",
    );
    expect(PREPARE_REVIEW_FINAL_GATE_HANDLER).toContain(
      "multi_source_collateral_prepare_review_final_gate",
    );
    expect(PREPARE_REGENERATE_ITEMS_HANDLER).toContain(
      "multi_source_collateral_prepare_regenerate_items",
    );
    expect(BUILD_GENERATE_ITEMS_HANDLER).toContain(
      "multi_source_collateral_build_generate_items",
    );
  });

  test("happy path without regenerate: sources → options → generate → review → persist", async () => {
    const draft = JSON.stringify({
      format: "linkedin-post",
      title: "Hook",
      content: "Body copy",
    });
    const { invoker, ran } = makeRecordingInvoker({
      "multi-source-collateral-generate": AGENT_REPLY(draft),
    });
    const { resolver: actionResolver, ran: actionsRan } = makeActionResolver({
      // Action handlers in production store full ToolResult envelopes; mocks
      // match that shape so selectors reading `.output.content` resolve.
      [ARTIFACT_LIST_HANDLER]: {
        content: { artifacts: [{ id: "a1", title: "Brief" }] },
      },
      [GRANOLA_LIST_NOTES_HANDLER]: {
        content: { notes: [{ id: "n1", title: "Call" }] },
      },
      [LIST_ISSUES_HANDLER]: {
        content: {
          issues: [{ id: "i1", identifier: "CL-1", title: "Ticket" }],
        },
      },
      [PREPARE_SOURCES_GATE_HANDLER]: {
        content: { kind: "form", fields: [] },
      },
      [FETCH_SOURCES_HANDLER]: {
        content: {
          sourceContext: "combined context",
          sourcesSummary: [{ kind: "artifact", id: "a1" }],
        },
      },
      [PREPARE_OPTIONS_GATE_HANDLER]: {
        content: { kind: "form", fields: [] },
      },
      [BUILD_GENERATE_ITEMS_HANDLER]: {
        content: {
          items: [
            {
              contentType: "linkedin-post",
              format: "linkedin-post",
              sourceContext: "combined context",
            },
          ],
        },
      },
      [PREPARE_REVIEW_GATE_HANDLER]: {
        content: { kind: "reviewList", rows: [] },
      },
      [PREPARE_REGENERATE_ITEMS_HANDLER]: {
        content: {
          shouldRegenerate: false,
          regenerateItems: [],
        },
      },
      [PERSIST_PIECES_HANDLER]: {
        content: { artifacts: [{ artifactId: "art_out" }] },
      },
    });

    const run = runLocal(workflow, { invokeStep: invoker, actionResolver });

    await run.signal("sources", {
      sourceIds: ["artifact:a1"],
      freeText: "Extra free text",
    });
    await run.signal("options", { contentTypes: ["linkedin-post"] });
    await run.signal("review", {
      approvedPieces: [
        { format: "linkedin-post", title: "Hook", content: "Body copy" },
      ],
      decisions: [
        {
          approved: true,
          format: "linkedin-post",
          title: "Hook",
          content: "Body copy",
        },
      ],
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
    expect(ran.map((r) => r.id)).toContain("multi-source-collateral-generate");
    expect(actionsRan.map((r) => r.ref)).toContain(PERSIST_PIECES_HANDLER);
    expect(ran.map((r) => r.id)).not.toContain(
      "multi-source-collateral-regenerate",
    );

    // Selectors project `.output.content` so the gate tool sees list payloads,
    // not ToolResult envelopes (CL-4624).
    const prepareSourcesInput = actionsRan.find(
      (r) => r.ref === PREPARE_SOURCES_GATE_HANDLER,
    )?.input as Record<string, unknown> | undefined;
    expect(prepareSourcesInput).toMatchObject({
      artifacts: [{ id: "a1", title: "Brief" }],
      notes: [{ id: "n1", title: "Call" }],
      issues: [{ id: "i1", identifier: "CL-1", title: "Ticket" }],
    });
    expect(prepareSourcesInput).not.toHaveProperty("callId");
  });

  test("regenerate path: review shouldRegenerate → regenerate → review-final → persist-after-regen", async () => {
    const draft = JSON.stringify({
      format: "blog-short",
      title: "V1",
      content: "First draft",
    });
    const revised = JSON.stringify({
      format: "blog-short",
      title: "V2",
      content: "Revised draft",
    });
    const { invoker, ran } = makeRecordingInvoker({
      "multi-source-collateral-generate": AGENT_REPLY(draft),
      "multi-source-collateral-regenerate": AGENT_REPLY(revised),
    });
    const { resolver: actionResolver, ran: actionsRan } = makeActionResolver({
      [ARTIFACT_LIST_HANDLER]: { content: { artifacts: [] } },
      [GRANOLA_LIST_NOTES_HANDLER]: { content: { notes: [] } },
      [LIST_ISSUES_HANDLER]: { content: { issues: [] } },
      [PREPARE_SOURCES_GATE_HANDLER]: {
        content: { kind: "form", fields: [] },
      },
      [FETCH_SOURCES_HANDLER]: {
        content: {
          sourceContext: "Only free text source",
          sourcesSummary: [],
        },
      },
      [PREPARE_OPTIONS_GATE_HANDLER]: {
        content: { kind: "form", fields: [] },
      },
      [BUILD_GENERATE_ITEMS_HANDLER]: {
        content: {
          items: [
            {
              contentType: "blog-short",
              format: "blog-short",
              sourceContext: "Only free text source",
            },
          ],
        },
      },
      [PREPARE_REVIEW_GATE_HANDLER]: {
        content: { kind: "reviewList", rows: [] },
      },
      [PREPARE_REGENERATE_ITEMS_HANDLER]: {
        content: {
          shouldRegenerate: true,
          regenerateItems: [
            {
              contentType: "blog-short",
              format: "blog-short",
              sourceContext: "Only free text source",
              previousContent: "First draft",
              feedback: "Make it punchier",
            },
          ],
        },
      },
      [PREPARE_REVIEW_FINAL_GATE_HANDLER]: {
        content: { kind: "reviewList", rows: [] },
      },
      [PERSIST_PIECES_HANDLER]: {
        content: { artifacts: [{ artifactId: "art_2" }] },
      },
    });

    const run = runLocal(workflow, { invokeStep: invoker, actionResolver });

    await run.signal("sources", {
      sourceIds: [],
      freeText: "Only free text source",
    });
    await run.signal("options", { contentTypes: ["blog-short"] });
    await run.signal("review", { approvedPieces: [], decisions: [] });
    await run.signal("review-final", {
      approvedPieces: [
        { format: "blog-short", title: "V2", content: "Revised draft" },
      ],
    });

    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
    expect(ran.map((r) => r.id)).toContain(
      "multi-source-collateral-regenerate",
    );
    const persistCalls = actionsRan.filter(
      (r) => r.ref === PERSIST_PIECES_HANDLER,
    );
    expect(persistCalls).toHaveLength(1);
  });
});

describe("parse helpers", () => {
  test("parseArtifactList ok / empty / failed", () => {
    expect(parseArtifactList({ artifacts: [{ id: "1" }] }).status).toBe("ok");
    expect(parseArtifactList({ artifacts: [] }).status).toBe("empty");
    expect(parseArtifactList(undefined).status).toBe("failed");
  });

  test("parseNoteList and parseIssueList tolerate wrappers", () => {
    expect(parseNoteList({ notes: [{ id: "n", title: "T" }] }).status).toBe(
      "ok",
    );
    expect(parseIssueList({ issues: [{ id: "i", title: "I" }] }).status).toBe(
      "ok",
    );
  });

  test("parseGeneratedPieces reads direct pieces", () => {
    const direct = parseGeneratedPieces([
      { format: "twitter-post", title: "T", content: "c" },
    ]);
    expect(direct).toHaveLength(1);
    expect(direct[0]?.format).toBe("twitter-post");
  });
});

describe("prompts", () => {
  test("covers every content type and builds a non-empty system prompt", () => {
    expect(CONTENT_TYPES.length).toBeGreaterThanOrEqual(5);
    const prompt = buildGenerationSystemPrompt();
    for (const { id } of CONTENT_TYPES) {
      expect(prompt).toContain(id);
    }
    expect(prompt.length).toBeGreaterThan(200);
  });
});
