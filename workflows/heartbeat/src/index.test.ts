import { describe, expect, test } from "bun:test";
import { runLocal } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";
import { evaluateSelector } from "@intx/workflow/runtime";
import type { ActionHandler } from "@intx/workflow";
import { mergeHeartbeatBriefSources } from "@workbench/shared";
import {
  DETERMINISTIC_TOOL_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_NONFATAL_TAG,
  STEP_TOOL_TAG,
} from "@workbench/agents";
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

// Mirror of the sidecar's argMap reshape (`runDeterministicToolStep`): each key
// pulls a top-level field (`{ from }`), a constant (`{ literal }`), or a field
// off a JSON envelope (`{ fromJson, field }` — for stringTool outputs whose
// payload is `{ content: "<json>" }`). Required `from` / `fromJson` fields throw
// when absent (same fail-loud contract as the sidecar harness). Used to prove
// the mail/artifact argMaps resolve against a real merged step input, not just
// to snapshot the static tag.
function resolveArgMap(
  argMap: Record<
    string,
    | { from: string; optional?: boolean }
    | { literal: unknown }
    | { fromJson: string; field: string; optional?: boolean }
  >,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(argMap)) {
    if ("literal" in spec) {
      out[key] = spec.literal;
      continue;
    }
    if ("fromJson" in spec) {
      const envelope =
        spec.fromJson in input ? input[spec.fromJson] : undefined;
      let parsed: unknown;
      if (typeof envelope === "string") {
        try {
          parsed = JSON.parse(envelope);
        } catch {
          parsed = undefined;
        }
      } else if (envelope !== null && typeof envelope === "object") {
        parsed = envelope;
      }
      const record =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      const fieldPresent = record !== undefined && spec.field in record;
      if (!fieldPresent) {
        if (spec.optional === true) continue;
        throw new Error(
          `argMap maps tool arg "${key}" from JSON field "${spec.field}" of input field "${spec.fromJson}", but that field is absent on the evaluated step input`,
        );
      }
      out[key] = record[spec.field];
      continue;
    }
    const present = spec.from in input;
    if (!present) {
      if (spec.optional === true) continue;
      throw new Error(
        `argMap maps tool arg "${key}" from input field "${spec.from}", but that field is absent on the evaluated step input`,
      );
    }
    out[key] = input[spec.from];
  }
  return out;
}

function argMapOf(
  id: string,
): Record<
  string,
  | { from: string; optional?: boolean }
  | { literal: unknown }
  | { fromJson: string; field: string; optional?: boolean }
> {
  const tag = stepPrimitive(id).agent.tags?.[STEP_ARGMAP_TAG];
  if (tag === undefined) throw new Error(`expected argMap tag on step "${id}"`);
  return JSON.parse(tag);
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

  test("each generated intake step is a deterministic call to its source's tool, nonFatal, with no inference source", () => {
    for (const source of WIRED_BRIEF_SOURCES) {
      const intake = stepPrimitive(heartbeatIntakeStepKey(source.key));
      expect(intake.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
      expect(intake.agent.tags?.[STEP_TOOL_TAG]).toContain(source.tool);
      expect(intake.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
      expect(intake.agent.inference.sources).toEqual([]);
      expect(intake.input).toEqual({ from: "trigger.payload" });
      expect(intake.agent.tags?.[STEP_ARGMAP_TAG]).toBe(
        JSON.stringify({
          enabledSources: { from: "enabledSources" },
          createdAfter: { from: "createdAfter" },
        }),
      );
      expect(intake.after).toBeUndefined();
    }
  });

  // Load-bearing: today's catalog generates one nonFatal intake step per
  // wired source, with merge-sources depending on all of them.
  test("today's catalog generates one intake step per wired source", () => {
    expect(WIRED_BRIEF_SOURCES.map((s) => s.key).sort()).toEqual([
      "attio",
      "granola",
      "linear",
      "vercel",
    ]);
    const intake = stepPrimitive(heartbeatIntakeStepKey("granola"));
    expect(intake.agent.id).toBe("heartbeat-intake-granola");
    expect(intake.agent.tags?.[STEP_TOOL_TAG]).toContain("granola_list_notes");
    expect(intake.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
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
  test("every intake step reads trigger.payload and narrows tool args via the shared fetch argMap", () => {
    for (const source of WIRED_BRIEF_SOURCES) {
      const intake = stepPrimitive(heartbeatIntakeStepKey(source.key));
      expect(intake.input).toEqual({ from: "trigger.payload" });
      expect(argMapOf(heartbeatIntakeStepKey(source.key))).toEqual({
        enabledSources: { from: "enabledSources" },
        createdAfter: { from: "createdAfter" },
      });
    }
  });

  // Both argMap fields are non-optional, which is only safe because
  // `enrichHeartbeatTriggerPayload` (apps/hub/src/lib/heartbeat-trigger-payload.ts)
  // stamps both unconditionally on every heartbeat fire — proves the argMap
  // actually resolves against the real enriched trigger payload shape, not
  // just that the static tag looks right.
  test("intake argMap resolves enabledSources/createdAfter from a real enriched trigger payload", () => {
    const args = resolveArgMap(
      argMapOf(heartbeatIntakeStepKey("granola")),
      TRIGGER_PAYLOAD,
    );
    expect(args.enabledSources).toEqual(TRIGGER_PAYLOAD.enabledSources);
    expect(args.createdAfter).toBe(TRIGGER_PAYLOAD.createdAfter);
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
      "heartbeat-intake-granola": {
        notes: [{ id: "note_1", title: "Acme call", summary: "Discovery" }],
      },
      "heartbeat-intake-linear": { issues: [] },
      "heartbeat-intake-attio": {
        attioActivity: { newCompanies: [], openTasks: [] },
      },
      "heartbeat-intake-vercel": { deployments: [] },
      "heartbeat-brief": { reply: briefReply },
    });
    const { resolver, ran: actionRan } = makeRecordingActionResolver({
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
    expect(ranStepIds).toContain("heartbeat-intake-granola");
    expect(ranStepIds).toContain("heartbeat-intake-linear");
    expect(ranStepIds).toContain("heartbeat-intake-attio");
    expect(ranStepIds).toContain("heartbeat-intake-vercel");
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
  // Integration seam — the mail step's decoded args carry the firing user's
  // usr_ address and the brief body; the artifact persists the same brief.
  // -------------------------------------------------------------------------
  test("mail_send receives the firing user's usr_ address and the artifact persists the brief", async () => {
    const briefReply = "# Morning brief\n\nAll clear today.";
    const { invoker } = makeRecordingInvoker({
      "heartbeat-intake-granola": { notes: [] },
      "heartbeat-intake-linear": { issues: [] },
      "heartbeat-intake-attio": {
        attioActivity: { newCompanies: [], openTasks: [] },
      },
      "heartbeat-intake-vercel": { deployments: [] },
      "heartbeat-brief": { reply: briefReply },
    });
    const { resolver, ran } = makeRecordingActionResolver({
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
