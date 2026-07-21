import { describe, expect, test } from "bun:test";
import { runLocal } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";
import { evaluateSelector } from "@intx/workflow/runtime";
import { mergeHeartbeatBriefSources } from "@workbench/shared";
import {
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_NONFATAL_TAG,
  STEP_TOOL_TAG,
} from "@workbench/agents";
import { WIRED_BRIEF_SOURCES } from "@workbench/shared";

import { workflow, heartbeatIntakeStepKey } from "./index";

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

function stepPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected step primitive for step id "${id}", got ${primitive?.kind ?? "undefined"}`,
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

function argMapOf(id: string): Record<
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
  createdAfter: "2026-07-04T00:00:00Z",
  runId: "run-heartbeat-1",
};

describe("heartbeat native workflow", () => {
  // -------------------------------------------------------------------------
  // Gate-free (load-bearing): no awaitSignal anywhere
  // -------------------------------------------------------------------------
  test("has no awaitSignal steps — every step is a plain step or map", () => {
    const kinds = Object.values(workflow.steps).map((s) => s.kind);
    expect(kinds.length).toBe(6 + WIRED_BRIEF_SOURCES.length);
    for (const kind of kinds) {
      expect(kind === "step" || kind === "map").toBe(true);
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
      "mail-refs",
      "merge-sources",
      "notify",
      "persist",
      "title",
    ]);
  });

  test("title is a deterministic call to heartbeat_format_brief_title with no inference source", () => {
    const title = stepPrimitive("title");
    expect(title.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(title.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "heartbeat_format_brief_title",
    );
    expect(title.agent.inference.sources).toEqual([]);
    expect(title.input).toEqual({ from: "trigger.payload" });
    expect(argMapOf("title")).toEqual({
      userDisplayName: { from: "userDisplayName" },
    });
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
  // wired source, with brief depending on all of them.
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
    expect(stepPrimitive("brief").after).toEqual(["merge-sources"]);
    expect(stepPrimitive("merge-sources").after).toEqual(
      WIRED_BRIEF_SOURCES.map((s) => heartbeatIntakeStepKey(s.key)),
    );
  });

  test("notify is a deterministic mail_send step with no inference source", () => {
    const notify = stepPrimitive("notify");
    expect(notify.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(notify.agent.tags?.[STEP_TOOL_TAG]).toContain("mail_send");
    expect(notify.agent.inference.sources).toEqual([]);
  });

  test("persist is a deterministic write_artifact step with no inference source", () => {
    const persist = stepPrimitive("persist");
    expect(persist.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(persist.agent.tags?.[STEP_TOOL_TAG]).toContain("write_artifact");
    expect(persist.agent.inference.sources).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Inline-inference brief step (default model)
  // -------------------------------------------------------------------------
  test("brief is an inline-inference step with a real prompt and the default model", () => {
    const brief = stepPrimitive("brief");
    expect(brief.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
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

  test("merge-sources projects every intake step into heartbeat_merge_brief_sources", () => {
    const intakeStepIds = WIRED_BRIEF_SOURCES.map((s) =>
      heartbeatIntakeStepKey(s.key),
    );
    const mergeSources = stepPrimitive("merge-sources");
    expect(mergeSources.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "heartbeat_merge_brief_sources",
    );
    expect(mergeSources.input).toEqual({
      project: { from: "steps" },
      fields: intakeStepIds,
    });
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
  // Mail addressing argMap
  // -------------------------------------------------------------------------
  test("mail-refs argMap builds artifact and workflow_run refs from persist + trigger runId", () => {
    expect(argMapOf("mail-refs")).toEqual({
      artifactId: { fromJson: "content", field: "artifactId" },
      runId: { from: "runId" },
      workflowLabel: { literal: "Company Heartbeat" },
    });
    expect(stepPrimitive("mail-refs").after).toEqual(["persist"]);
  });

  test("mail-refs argMap resolves artifactId from write_artifact stringTool content envelope", () => {
    // Real write_artifact returns JSON.stringify({ artifactId, version, title })
    // as the tool content; the step output is { content: "<that json>" }.
    // A top-level { from: "artifactId" } never sees it (prod failure after
    // CL-4069 unblocked tool pins).
    const mailRefsInput = {
      ...TRIGGER_PAYLOAD,
      content: JSON.stringify({
        artifactId: "art_1",
        version: 1,
        title: "Jordan Lee's Morning Brief - 04/07/26",
      }),
    };
    const args = resolveArgMap(argMapOf("mail-refs"), mailRefsInput);
    expect(args.artifactId).toBe("art_1");
    expect(args.runId).toBe(TRIGGER_PAYLOAD.runId);
    expect(args.workflowLabel).toBe("Company Heartbeat");
  });

  test("mail-refs argMap throws when write_artifact content lacks artifactId", () => {
    expect(() =>
      resolveArgMap(argMapOf("mail-refs"), {
        ...TRIGGER_PAYLOAD,
        content: JSON.stringify({ version: 1, title: "no id" }),
      }),
    ).toThrow(/artifactId/);
  });

  test("notify argMap addresses the mail to the firing user with the computed title as subject, the brief as content, and artifact refs", () => {
    expect(argMapOf("notify")).toEqual({
      to: { from: "userAddress" },
      subject: { from: "title" },
      content: { from: "reply" },
      refs: { from: "refs" },
    });
    expect(stepPrimitive("notify").after).toEqual([
      "brief",
      "title",
      "persist",
      "mail-refs",
    ]);
  });

  // -------------------------------------------------------------------------
  // Artifact persistence argMap
  // -------------------------------------------------------------------------
  test("persist argMap saves the brief body as a stable morning-brief artifact, never 'report'", () => {
    expect(argMapOf("persist")).toEqual({
      title: { from: "title" },
      body: { from: "reply" },
      kind: { literal: "morning-brief" },
      jobLabel: { literal: "Morning Brief" },
    });
    expect(stepPrimitive("persist").after).toEqual(["brief", "title"]);
  });

  // -------------------------------------------------------------------------
  // Full run — completes with ZERO signals (proves gate-free / unattended)
  // -------------------------------------------------------------------------
  test("runs intake → brief → persist → notify to completion with no human input", async () => {
    const briefReply =
      "# Morning brief\n\n## What happened\n- Discovery call with Acme.";
    const { invoker, ran } = makeRecordingInvoker({
      "heartbeat-intake-granola": {
        notes: [{ id: "note_1", title: "Acme call", summary: "Discovery" }],
      },
      "heartbeat-intake-linear": { issues: [] },
      "heartbeat-intake-attio": {
        attioActivity: { newCompanies: [], openTasks: [] },
      },
      "heartbeat-intake-vercel": { deployments: [] },
      "heartbeat-merge-sources": {
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
      "heartbeat-brief": { reply: briefReply },
      "heartbeat-title": {
        content: { title: "Jordan Lee's Morning Brief - 04/07/26" },
      },
      "heartbeat-persist": {
        content: JSON.stringify({
          artifactId: "art_1",
          version: 1,
          title: "Jordan Lee's Morning Brief - 04/07/26",
        }),
      },
      "heartbeat-mail-refs": {
        content: {
          refs: [
            { kind: "artifact", ref: "art_1", label: "Open brief" },
            {
              kind: "workflow_run",
              ref: "run-heartbeat-1",
              label: "Open Company Heartbeat",
            },
          ],
        },
      },
      "heartbeat-notify": { messageId: "mail_1" },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      triggerPayload: TRIGGER_PAYLOAD,
    });

    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");

    const ranIds = ran.map((r) => r.id);
    expect(ranIds).toContain("heartbeat-intake-granola");
    expect(ranIds).toContain("heartbeat-intake-linear");
    expect(ranIds).toContain("heartbeat-intake-attio");
    expect(ranIds).toContain("heartbeat-intake-vercel");
    expect(ranIds).toContain("heartbeat-merge-sources");
    expect(ranIds).toContain("heartbeat-brief");
    expect(ranIds).toContain("heartbeat-title");
    expect(ranIds).toContain("heartbeat-persist");
    expect(ranIds).toContain("heartbeat-mail-refs");
    expect(ranIds).toContain("heartbeat-notify");
    const persistIdx = ranIds.indexOf("heartbeat-persist");
    const mailRefsIdx = ranIds.indexOf("heartbeat-mail-refs");
    const notifyIdx = ranIds.indexOf("heartbeat-notify");
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    expect(mailRefsIdx).toBeGreaterThan(persistIdx);
    expect(notifyIdx).toBeGreaterThan(mailRefsIdx);
  });

  // -------------------------------------------------------------------------
  // Integration seam — the mail step's decoded args carry the firing user's
  // usr_ address and the brief body; the artifact persists the same brief.
  // -------------------------------------------------------------------------
  test("mail_send receives the firing user's usr_ address and the artifact persists the brief", async () => {
    const briefReply = "# Morning brief\n\nAll clear today.";
    const { invoker, ran } = makeRecordingInvoker({
      "heartbeat-intake-granola": { notes: [] },
      "heartbeat-intake-linear": { issues: [] },
      "heartbeat-intake-attio": {
        attioActivity: { newCompanies: [], openTasks: [] },
      },
      "heartbeat-intake-vercel": { deployments: [] },
      "heartbeat-merge-sources": {
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
      "heartbeat-brief": { reply: briefReply },
      "heartbeat-title": {
        content: { title: "Jordan Lee's Morning Brief - 04/07/26" },
      },
      "heartbeat-persist": {
        content: JSON.stringify({
          artifactId: "art_1",
          version: 1,
          title: "Jordan Lee's Morning Brief - 04/07/26",
        }),
      },
      "heartbeat-mail-refs": {
        content: {
          refs: [
            { kind: "artifact", ref: "art_1", label: "Open brief" },
            {
              kind: "workflow_run",
              ref: "run-heartbeat-1",
              label: "Open Company Heartbeat",
            },
          ],
        },
      },
      "heartbeat-notify": { messageId: "mail_1" },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      triggerPayload: TRIGGER_PAYLOAD,
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    // Pin the persist → mail-refs handoff on the recorded merge input, not only
    // the static argMap tag: mail-refs must see write_artifact's content envelope.
    const mailRefsInput = ran.find((r) => r.id === "heartbeat-mail-refs")
      ?.input as Record<string, unknown> | undefined;
    if (mailRefsInput === undefined)
      throw new Error("mail-refs step did not run");
    const mailRefsArgs = resolveArgMap(argMapOf("mail-refs"), mailRefsInput);
    expect(mailRefsArgs.artifactId).toBe("art_1");
    expect(mailRefsArgs.runId).toBe(TRIGGER_PAYLOAD.runId);
    expect(mailRefsArgs.workflowLabel).toBe("Company Heartbeat");

    const notifyInput = ran.find((r) => r.id === "heartbeat-notify")?.input as
      | Record<string, unknown>
      | undefined;
    if (notifyInput === undefined) throw new Error("notify step did not run");

    const mailArgs = resolveArgMap(argMapOf("notify"), notifyInput);
    expect(mailArgs.to).toBe(TRIGGER_PAYLOAD.userAddress);
    expect(String(mailArgs.to).startsWith("usr_")).toBe(true);
    expect(mailArgs.subject).toBe("Jordan Lee's Morning Brief - 04/07/26");
    expect(mailArgs.content).toBe(briefReply);
    expect(mailArgs.refs).toEqual([
      { kind: "artifact", ref: "art_1", label: "Open brief" },
      {
        kind: "workflow_run",
        ref: "run-heartbeat-1",
        label: "Open Company Heartbeat",
      },
    ]);

    const persistInput = ran.find((r) => r.id === "heartbeat-persist")
      ?.input as Record<string, unknown> | undefined;
    if (persistInput === undefined) throw new Error("persist step did not run");

    const artifactArgs = resolveArgMap(argMapOf("persist"), persistInput);
    expect(artifactArgs.body).toBe(briefReply);
    expect(artifactArgs.kind).toBe("morning-brief");
    expect(artifactArgs.title).toBe("Jordan Lee's Morning Brief - 04/07/26");
  });
});
