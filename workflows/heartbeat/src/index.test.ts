import { describe, expect, test } from "bun:test";
import { runLocal } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";
import { evaluateSelector } from "@intx/workflow/runtime";
import type { ActionHandler } from "@intx/workflow";
import { mergeHeartbeatBriefSources } from "@workbench/shared";
import { STEP_KIND_TAG, STEP_TOOL_TAG } from "@workbench/agents";
import { WIRED_BRIEF_SOURCES } from "@workbench/shared";

import {
  workflow,
  heartbeatIntakeStepKey,
  HEARTBEAT_FORMAT_BRIEF_TITLE_HANDLER,
  HEARTBEAT_MERGE_BRIEF_SOURCES_HANDLER,
  HEARTBEAT_FORMAT_BRIEF_DOCUMENT_HANDLER,
  WRITE_ARTIFACT_HANDLER,
  HEARTBEAT_FORMAT_BRIEF_NOTIFY_HANDLER,
  MAIL_SEND_HANDLER,
  HEARTBEAT_INTAKE_SOURCE_HANDLER,
} from "./index";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
type ActionOutput = unknown | ((input: Record<string, unknown>) => unknown);

function makeRecordingActionResolver(
  outputs: Record<string, ActionOutput> = {},
): {
  resolver: (ref: string) => ActionHandler;
  ran: { handler: string; input: unknown }[];
} {
  const ran: { handler: string; input: unknown }[] = [];
  const resolver = (ref: string): ActionHandler => {
    return async (input) => {
      ran.push({ handler: ref, input });
      const output = outputs[ref];
      if (typeof output === "function") {
        return (output as (input: Record<string, unknown>) => unknown)(
          input as Record<string, unknown>,
        );
      }
      return output ?? null;
    };
  };
  return { resolver, ran };
}

function stepPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected step primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

const TRIGGER_PAYLOAD = {
  reason: "scheduled-heartbeat",
  userAddress: "usr_abc123@workbench.local",
  userRefId: "usr_abc123",
  userDisplayName: "Jordan Lee",
  enabledSources: ["attio", "granola", "linear", "vercel"],
  createdAfter: "2026-07-04T00:00:00Z",
  runId: "run-heartbeat-1",
};

describe("heartbeat native workflow", () => {
  // -------------------------------------------------------------------------
  // Gate-free (load-bearing): no awaitSignal anywhere
  // -------------------------------------------------------------------------
  test("has no awaitSignal steps — every step is a plain step or native action", () => {
    const kinds = Object.values(workflow.steps).map((s) => s.kind);
    expect(kinds.length).toBe(7 + WIRED_BRIEF_SOURCES.length);
    for (const kind of kinds) {
      expect(kind === "step" || kind === "action").toBe(true);
      expect(kind).not.toBe("awaitSignal");
    }
  });

  // -------------------------------------------------------------------------
  // No trigger declaration: firing is owned entirely by the hub's
  // scheduled_trigger table, so the definition declares no schedule trigger.
  // -------------------------------------------------------------------------
  test("declares no trigger; firing is owned by the hub scheduler", () => {
    expect(workflow.triggers).toEqual([{ type: "manual" }]);
  });

  // -------------------------------------------------------------------------
  // Deterministic tool steps — generated from WIRED_BRIEF_SOURCES
  // -------------------------------------------------------------------------
  test("generates exactly one intake step per WIRED_BRIEF_SOURCES entry", () => {
    const intakeStepIds = WIRED_BRIEF_SOURCES.map((s) =>
      heartbeatIntakeStepKey(s.key),
    );
    for (const stepId of intakeStepIds) {
      expect(Object.keys(workflow.steps)).toContain(stepId);
    }
    const nonIntakeSteps = Object.keys(workflow.steps).filter(
      (id) => !intakeStepIds.includes(id),
    );
    expect(nonIntakeSteps.sort()).toEqual([
      "brief",
      "document",
      "merge-sources",
      "notify",
      "notify-prep",
      "persist",
      "title",
    ]);
  });

  // -------------------------------------------------------------------------
  // Native action steps
  // -------------------------------------------------------------------------
  test("title is a native action calling heartbeat_format_brief_title, tolerating an absent userDisplayName", () => {
    const title = actionPrimitive("title");
    expect(title.handler).toContain("heartbeat_format_brief_title");
    expect(title.effect?.requires).toEqual([title.handler]);
    expect(title.input).toEqual({
      project: { from: "trigger.payload" },
      fields: ["userDisplayName"],
    });
    // Bug fix: a `project` selector assigns `source[field]` unconditionally
    // (no presence check), so a trigger payload missing `userDisplayName`
    // entirely (an agent principal, or an identity-lookup miss) still
    // evaluates — it never throws the way the old non-optional argMap did.
    const evaluated = evaluateSelector(title.input!, {
      trigger: { payload: { reason: "scheduled-heartbeat" } },
      steps: {},
    }) as Record<string, unknown>;
    expect(evaluated).toEqual({ userDisplayName: undefined });
  });

  test("merge-sources is a native action projecting every intake step into heartbeat_merge_brief_sources", () => {
    const intakeStepIds = WIRED_BRIEF_SOURCES.map((s) =>
      heartbeatIntakeStepKey(s.key),
    );
    const mergeSources = actionPrimitive("merge-sources");
    expect(mergeSources.handler).toContain("heartbeat_merge_brief_sources");
    expect(mergeSources.effect?.requires).toEqual([mergeSources.handler]);
    expect(mergeSources.input).toEqual({
      project: { from: "steps" },
      fields: intakeStepIds,
    });
    expect(mergeSources.after).toEqual(intakeStepIds);
  });

  test("document is a native action merging title.output.content and brief.output", () => {
    const document = actionPrimitive("document");
    expect(document.handler).toContain("heartbeat_format_brief_document");
    expect(document.effect?.requires).toEqual([document.handler]);
    expect(document.input).toEqual({
      merge: [
        { from: "steps.title.output.content" },
        { from: "steps.brief.output" },
      ],
    });
    expect(document.after).toEqual(["title", "brief"]);
  });

  test("persist is a native action writing a stable morning-brief artifact, never 'report'", () => {
    const persist = actionPrimitive("persist");
    expect(persist.handler).toContain("write_artifact");
    expect(persist.effect?.requires).toEqual([persist.handler]);
    expect(persist.input).toEqual({
      merge: [
        {
          project: { from: "steps.document.output.content" },
          fields: ["title", "body"],
        },
        {
          literal: { kind: "morning-brief", jobLabel: "Morning Brief" },
        },
      ],
    });
    expect(persist.after).toEqual(["document"]);
  });

  test("notify-prep is a native action building mail_send's exact argument shape", () => {
    const notifyPrep = actionPrimitive("notify-prep");
    expect(notifyPrep.handler).toContain("heartbeat_format_brief_notify");
    expect(notifyPrep.effect?.requires).toEqual([notifyPrep.handler]);
    expect(notifyPrep.input).toEqual({
      merge: [
        {
          project: {
            merge: [
              { from: "trigger.payload" },
              { from: "steps.document.output.content" },
              { from: "steps.persist.output.content" },
            ],
          },
          fields: ["userAddress", "title", "body", "artifactId", "runId"],
        },
        { literal: { workflowLabel: "Morning brief" } },
      ],
    });
    expect(notifyPrep.after).toEqual(["document", "persist"]);
  });

  test("notify-prep input resolves against real merged step outputs", () => {
    const notifyPrep = actionPrimitive("notify-prep");
    const evaluated = evaluateSelector(notifyPrep.input!, {
      trigger: { payload: TRIGGER_PAYLOAD },
      steps: {
        document: {
          output: {
            content: {
              title: "Jordan Lee's Morning Brief - 04/07/26",
              body: "# Morning brief\n\nAll clear today.",
            },
          },
        },
        persist: {
          output: {
            content: {
              artifactId: "art_1",
              version: 1,
              title: "Jordan Lee's Morning Brief - 04/07/26",
            },
          },
        },
      },
    }) as Record<string, unknown>;
    expect(evaluated).toEqual({
      userAddress: TRIGGER_PAYLOAD.userAddress,
      title: "Jordan Lee's Morning Brief - 04/07/26",
      body: "# Morning brief\n\nAll clear today.",
      artifactId: "art_1",
      runId: TRIGGER_PAYLOAD.runId,
      workflowLabel: "Morning brief",
    });
  });

  test("notify is a native action passing notify-prep's output through verbatim", () => {
    const notify = actionPrimitive("notify");
    expect(notify.handler).toContain("mail_send");
    expect(notify.effect?.requires).toEqual([notify.handler]);
    expect(notify.input).toEqual({ from: "steps.notify-prep.output.content" });
    expect(notify.after).toEqual(["notify-prep"]);
  });

  test("each generated intake step is a native action calling heartbeat_intake_source, parameterized by its source's tool", () => {
    for (const source of WIRED_BRIEF_SOURCES) {
      const intake = actionPrimitive(heartbeatIntakeStepKey(source.key));
      expect(intake.handler).toBe(HEARTBEAT_INTAKE_SOURCE_HANDLER);
      expect(intake.effect?.requires).toEqual([
        HEARTBEAT_INTAKE_SOURCE_HANDLER,
      ]);
      expect(intake.input).toEqual({
        merge: [
          {
            project: { from: "trigger.payload" },
            fields: ["enabledSources", "createdAfter"],
          },
          { literal: { tool: source.tool } },
        ],
      });
      expect(intake.after).toBeUndefined();
    }
  });

  // Load-bearing: today's catalog generates one intake action step per wired
  // source, all calling the same generic wrapper handler, parameterized by
  // `tool`, with merge-sources depending on all of them.
  test("today's catalog generates one intake step per wired source", () => {
    expect(WIRED_BRIEF_SOURCES.map((s) => s.key).sort()).toEqual([
      "attio",
      "granola",
      "linear",
      "vercel",
    ]);
    const intake = actionPrimitive(heartbeatIntakeStepKey("granola"));
    expect(intake.handler).toBe(HEARTBEAT_INTAKE_SOURCE_HANDLER);
    const evaluated = evaluateSelector(intake.input!, {
      trigger: { payload: { enabledSources: ["granola"] } },
      steps: {},
    }) as Record<string, unknown>;
    expect(evaluated.tool).toBe("granola_list_notes");
    expect(actionPrimitive("merge-sources").after).toEqual(
      WIRED_BRIEF_SOURCES.map((s) => heartbeatIntakeStepKey(s.key)),
    );
  });

  // -------------------------------------------------------------------------
  // Inline-inference brief step (default model)
  // -------------------------------------------------------------------------
  test("brief is a native reasoning step (agentStep) with a real prompt and the default model", () => {
    const brief = stepPrimitive("brief");
    expect(brief.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(brief.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(brief.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(brief.agent.capabilities).toEqual([]);
    // No per-step model preference declared → the deploy default model
    // (deepseek-v4-flash) is used, so no source is pinned on the definition.
    expect(brief.agent.inference.sources).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Selector wiring
  // -------------------------------------------------------------------------
  test("every intake step reads trigger.payload and narrows to { tool, enabledSources, createdAfter }", () => {
    for (const source of WIRED_BRIEF_SOURCES) {
      const intake = actionPrimitive(heartbeatIntakeStepKey(source.key));
      expect(intake.input).toEqual({
        merge: [
          {
            project: { from: "trigger.payload" },
            fields: ["enabledSources", "createdAfter"],
          },
          { literal: { tool: source.tool } },
        ],
      });
    }
  });

  // Proves the selector actually resolves against the real enriched trigger
  // payload shape (`enrichHeartbeatTriggerPayload`,
  // apps/hub/src/lib/heartbeat-trigger-payload.ts stamps both fields
  // unconditionally on every heartbeat fire), not just that the static
  // selector looks right.
  test("intake selector resolves enabledSources/createdAfter/tool from a real enriched trigger payload", () => {
    const intake = actionPrimitive(heartbeatIntakeStepKey("granola"));
    const evaluated = evaluateSelector(intake.input!, {
      trigger: { payload: TRIGGER_PAYLOAD },
      steps: {},
    }) as Record<string, unknown>;
    expect(evaluated.enabledSources).toEqual(TRIGGER_PAYLOAD.enabledSources);
    expect(evaluated.createdAfter).toBe(TRIGGER_PAYLOAD.createdAfter);
    expect(evaluated.tool).toBe("granola_list_notes");
  });

  test("brief merges the trigger payload and merged sources content", () => {
    expect(stepPrimitive("brief").input).toEqual({
      merge: [
        { from: "trigger.payload" },
        { from: "steps.merge-sources.output.content" },
      ],
    });
    expect(stepPrimitive("brief").after).toEqual(["merge-sources"]);
  });

  test("brief input selector keeps every source when intake envelopes share callId/content/isError", () => {
    const intakeStepIds = WIRED_BRIEF_SOURCES.map((s) =>
      heartbeatIntakeStepKey(s.key),
    );
    const steps: Record<string, { output: unknown }> = {
      "intake-granola": {
        output: {
          callId: "c1",
          isError: false,
          content: JSON.stringify({
            notes: [{ id: "n1", title: "Acme call" }],
          }),
        },
      },
      "intake-linear": {
        output: {
          callId: "c2",
          isError: false,
          content: JSON.stringify({ issues: [{ id: "LIN-1" }] }),
        },
      },
      "intake-attio": {
        output: {
          callId: "c3",
          isError: false,
          content: JSON.stringify({ attioActivity: { openTasks: [] } }),
        },
      },
      "intake-vercel": {
        output: {
          callId: "c4",
          isError: true,
          content: "403 forbidden",
        },
      },
    };
    const mergedSources = mergeHeartbeatBriefSources(
      Object.fromEntries(intakeStepIds.map((id) => [id, steps[id]])),
    );
    const briefSelector = stepPrimitive("brief").input;
    if (briefSelector === undefined) {
      throw new Error("brief step has no input selector");
    }
    const briefInput = evaluateSelector(briefSelector, {
      trigger: { payload: TRIGGER_PAYLOAD },
      steps: {
        ...steps,
        "merge-sources": {
          output: { content: mergedSources, callId: "merge", isError: false },
        },
      },
    }) as Record<string, unknown>;

    const sources = briefInput.sources as Record<string, unknown>;
    expect(sources.granola).toEqual(mergedSources.sources.granola);
    expect(sources.linear).toEqual(mergedSources.sources.linear);
    expect(sources.attio).toEqual(mergedSources.sources.attio);
    expect(sources.vercel).toEqual(mergedSources.sources.vercel);
    expect(briefInput.userAddress).toBe(TRIGGER_PAYLOAD.userAddress);
  });

  // -------------------------------------------------------------------------
  // Full run — completes with ZERO signals (proves gate-free / unattended)
  // -------------------------------------------------------------------------
  test("runs intake → brief → persist → notify to completion with no human input", async () => {
    const briefReply =
      "# Morning brief\n\n## What happened\n- Discovery call with Acme.";
    const { invoker, ran: stepRan } = makeRecordingInvoker({
      "heartbeat-brief": { reply: briefReply },
    });
    const intakeContentByTool: Record<string, unknown> = {
      granola_list_notes: {
        notes: [{ id: "note_1", title: "Acme call", summary: "Discovery" }],
      },
      linear_list_issues: { issues: [] },
      attio_recent_activity: {
        attioActivity: { newCompanies: [], openTasks: [] },
      },
      vercel_list_deployments: { deployments: [] },
    };
    const { resolver, ran: actionRan } = makeRecordingActionResolver({
      [HEARTBEAT_INTAKE_SOURCE_HANDLER]: (input: Record<string, unknown>) => ({
        content: JSON.stringify(intakeContentByTool[input.tool as string]),
        isError: false,
      }),
      [HEARTBEAT_MERGE_BRIEF_SOURCES_HANDLER]: {
        content: {
          sources: {
            granola: {
              notes: [
                { id: "note_1", title: "Acme call", summary: "Discovery" },
              ],
            },
            linear: { issues: [] },
            attio: {
              attioActivity: { newCompanies: [], openTasks: [] },
            },
            vercel: { deployments: [] },
          },
        },
      },
      [HEARTBEAT_FORMAT_BRIEF_TITLE_HANDLER]: {
        content: { title: "Jordan Lee's Morning Brief - 04/07/26" },
      },
      [HEARTBEAT_FORMAT_BRIEF_DOCUMENT_HANDLER]: {
        content: {
          title: "Jordan Lee's Morning Brief - 04/07/26",
          body: briefReply,
        },
      },
      [WRITE_ARTIFACT_HANDLER]: {
        content: {
          artifactId: "art_1",
          version: 1,
          title: "Jordan Lee's Morning Brief - 04/07/26",
        },
      },
      [HEARTBEAT_FORMAT_BRIEF_NOTIFY_HANDLER]: {
        content: {
          to: TRIGGER_PAYLOAD.userAddress,
          subject: "Jordan Lee's Morning Brief - 04/07/26",
          content: briefReply,
          refs: [
            { kind: "artifact", ref: "art_1", label: "Open brief" },
            {
              kind: "workflow_run",
              ref: "run-heartbeat-1",
              label: "Open Morning brief",
            },
          ],
        },
      },
      [MAIL_SEND_HANDLER]: { messageId: "mail_1" },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
      triggerPayload: TRIGGER_PAYLOAD,
    });

    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");

    const ranStepIds = stepRan.map((r) => r.id);
    const ranHandlers = actionRan.map((r) => r.handler);
    const intakeCalls = actionRan.filter(
      (r) => r.handler === HEARTBEAT_INTAKE_SOURCE_HANDLER,
    );
    expect(intakeCalls.length).toBe(WIRED_BRIEF_SOURCES.length);
    const calledTools = intakeCalls
      .map((r) => (r.input as Record<string, unknown>).tool)
      .sort();
    expect(calledTools).toEqual(WIRED_BRIEF_SOURCES.map((s) => s.tool).sort());
    expect(ranStepIds).toContain("heartbeat-brief");
    expect(ranHandlers).toContain(HEARTBEAT_MERGE_BRIEF_SOURCES_HANDLER);
    expect(ranHandlers).toContain(HEARTBEAT_FORMAT_BRIEF_TITLE_HANDLER);
    expect(ranHandlers).toContain(HEARTBEAT_FORMAT_BRIEF_DOCUMENT_HANDLER);
    expect(ranHandlers).toContain(WRITE_ARTIFACT_HANDLER);
    expect(ranHandlers).toContain(HEARTBEAT_FORMAT_BRIEF_NOTIFY_HANDLER);
    expect(ranHandlers).toContain(MAIL_SEND_HANDLER);
    const persistIdx = ranHandlers.indexOf(WRITE_ARTIFACT_HANDLER);
    const notifyPrepIdx = ranHandlers.indexOf(
      HEARTBEAT_FORMAT_BRIEF_NOTIFY_HANDLER,
    );
    const notifyIdx = ranHandlers.indexOf(MAIL_SEND_HANDLER);
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    expect(notifyPrepIdx).toBeGreaterThan(persistIdx);
    expect(notifyIdx).toBeGreaterThan(notifyPrepIdx);
  });

  // -------------------------------------------------------------------------
  // A failing source degrades the brief, never the run
  // -------------------------------------------------------------------------
  test("one source's intake action returning a degraded envelope still completes the run", async () => {
    const briefReply = "# Morning brief\n\nMostly clear.";
    const { invoker } = makeRecordingInvoker({
      "heartbeat-brief": { reply: briefReply },
    });
    const intakeContentByTool: Record<string, unknown> = {
      granola_list_notes: { notes: [] },
      linear_list_issues: { issues: [] },
      vercel_list_deployments: { deployments: [] },
    };
    const { resolver, ran: actionRan } = makeRecordingActionResolver({
      // `heartbeat_intake_source`'s real contract: the outer
      // `ToolResult.isError` is ALWAYS false — `runDeterministicToolStep`
      // (apps/sidecar/src/step-tool-harness.ts) is used for native `action`
      // dispatch too and throws whenever the outer `isError` is true, and
      // `ActionPrimitive` has no `nonFatal` escape, so that throw would fail
      // this whole run. A missing credential or source-side failure is
      // carried inside `content` as `{ isError: true, error }` instead —
      // exactly what this mock returns for attio here, proving that shape
      // alone (never an outer isError, never a throw) is what keeps the run
      // completing. `mergeHeartbeatBriefSources` parsing that nested shape
      // into a per-source "not available" note is covered directly against
      // the real function in `heartbeat-brief-merge.test.ts`
      // (`@workbench/shared`) — this test proves the run-level half: the
      // degraded envelope this wrapper produces never reaches `ctx.perform`
      // as a failure.
      [HEARTBEAT_INTAKE_SOURCE_HANDLER]: (input: Record<string, unknown>) => {
        const tool = input.tool as string;
        if (tool === "attio_recent_activity") {
          return {
            isError: false,
            content: {
              isError: true,
              error: "source unavailable: no attio credential configured",
            },
          };
        }
        return {
          content: JSON.stringify(intakeContentByTool[tool]),
          isError: false,
        };
      },
      [HEARTBEAT_MERGE_BRIEF_SOURCES_HANDLER]: {
        content: {
          sources: {
            granola: { notes: [] },
            linear: { issues: [] },
            attio: {
              isError: true,
              error: "source unavailable: no attio credential configured",
            },
            vercel: { deployments: [] },
          },
        },
      },
      [HEARTBEAT_FORMAT_BRIEF_TITLE_HANDLER]: {
        content: { title: "Jordan Lee's Morning Brief - 04/07/26" },
      },
      [HEARTBEAT_FORMAT_BRIEF_DOCUMENT_HANDLER]: {
        content: {
          title: "Jordan Lee's Morning Brief - 04/07/26",
          body: briefReply,
        },
      },
      [WRITE_ARTIFACT_HANDLER]: {
        content: {
          artifactId: "art_1",
          version: 1,
          title: "Jordan Lee's Morning Brief - 04/07/26",
        },
      },
      [HEARTBEAT_FORMAT_BRIEF_NOTIFY_HANDLER]: {
        content: {
          to: TRIGGER_PAYLOAD.userAddress,
          subject: "Jordan Lee's Morning Brief - 04/07/26",
          content: briefReply,
          refs: [],
        },
      },
      [MAIL_SEND_HANDLER]: { messageId: "mail_1" },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
      triggerPayload: TRIGGER_PAYLOAD,
    });
    const result = await run.complete;

    // The genuine capability-gap fix: the run completes even though one
    // intake step's tool call failed — a thrown tool error, or an outer
    // isError, inside an `action`'s handler would have failed the whole run
    // (no `nonFatal` on `ActionPrimitive`), so this only passes because
    // `heartbeat_intake_source` never produces either for a source failure.
    expect(result.terminalStatus).toBe("completed");

    const attioCall = actionRan.find(
      (r) =>
        r.handler === HEARTBEAT_INTAKE_SOURCE_HANDLER &&
        (r.input as Record<string, unknown>).tool === "attio_recent_activity",
    );
    if (attioCall === undefined) throw new Error("attio intake did not run");
  });

  // -------------------------------------------------------------------------
  // Integration seam — the mail step's decoded args carry the firing user's
  // usr_ address and the brief body; the artifact persists the same brief.
  // -------------------------------------------------------------------------
  test("mail_send receives the firing user's usr_ address and the artifact persists the brief", async () => {
    const briefReply = "# Morning brief\n\nAll clear today.";
    const { invoker } = makeRecordingInvoker({
      "heartbeat-brief": { reply: briefReply },
    });
    const { resolver, ran } = makeRecordingActionResolver({
      [HEARTBEAT_INTAKE_SOURCE_HANDLER]: {
        content: JSON.stringify({}),
        isError: false,
      },
      [HEARTBEAT_MERGE_BRIEF_SOURCES_HANDLER]: {
        content: {
          sources: {
            granola: { notes: [] },
            linear: { issues: [] },
            attio: {
              attioActivity: { newCompanies: [], openTasks: [] },
            },
            vercel: { deployments: [] },
          },
        },
      },
      [HEARTBEAT_FORMAT_BRIEF_TITLE_HANDLER]: {
        content: { title: "Jordan Lee's Morning Brief - 04/07/26" },
      },
      [HEARTBEAT_FORMAT_BRIEF_DOCUMENT_HANDLER]: {
        content: {
          title: "Jordan Lee's Morning Brief - 04/07/26",
          body: briefReply,
        },
      },
      [WRITE_ARTIFACT_HANDLER]: {
        content: {
          artifactId: "art_1",
          version: 1,
          title: "Jordan Lee's Morning Brief - 04/07/26",
        },
      },
      [HEARTBEAT_FORMAT_BRIEF_NOTIFY_HANDLER]: {
        content: {
          to: TRIGGER_PAYLOAD.userAddress,
          subject: "Jordan Lee's Morning Brief - 04/07/26",
          content: briefReply,
          refs: [
            { kind: "artifact", ref: "art_1", label: "Open brief" },
            {
              kind: "workflow_run",
              ref: "run-heartbeat-1",
              label: "Open Morning brief",
            },
          ],
        },
      },
      [MAIL_SEND_HANDLER]: { messageId: "mail_1" },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
      triggerPayload: TRIGGER_PAYLOAD,
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const notifyPrepInput = ran.find(
      (r) => r.handler === HEARTBEAT_FORMAT_BRIEF_NOTIFY_HANDLER,
    )?.input as Record<string, unknown> | undefined;
    if (notifyPrepInput === undefined)
      throw new Error("notify-prep step did not run");
    expect(notifyPrepInput.artifactId).toBe("art_1");
    expect(notifyPrepInput.userAddress).toBe(TRIGGER_PAYLOAD.userAddress);
    expect(notifyPrepInput.runId).toBe(TRIGGER_PAYLOAD.runId);
    expect(notifyPrepInput.workflowLabel).toBe("Morning brief");

    const notifyInput = ran.find((r) => r.handler === MAIL_SEND_HANDLER)
      ?.input as Record<string, unknown> | undefined;
    if (notifyInput === undefined) throw new Error("notify step did not run");

    expect(notifyInput.to).toBe(TRIGGER_PAYLOAD.userAddress);
    expect(String(notifyInput.to).startsWith("usr_")).toBe(true);
    expect(notifyInput.subject).toBe("Jordan Lee's Morning Brief - 04/07/26");
    expect(notifyInput.content).toBe(briefReply);
    expect(notifyInput.refs).toEqual([
      { kind: "artifact", ref: "art_1", label: "Open brief" },
      {
        kind: "workflow_run",
        ref: "run-heartbeat-1",
        label: "Open Morning brief",
      },
    ]);

    const persistInput = ran.find((r) => r.handler === WRITE_ARTIFACT_HANDLER)
      ?.input as Record<string, unknown> | undefined;
    if (persistInput === undefined) throw new Error("persist step did not run");

    expect(persistInput.body).toBe(briefReply);
    expect(persistInput.kind).toBe("morning-brief");
    expect(persistInput.title).toBe("Jordan Lee's Morning Brief - 04/07/26");
  });
});
