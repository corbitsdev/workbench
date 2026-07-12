import { describe, expect, test } from "bun:test";
import { runLocal } from "@intx/workflow/runlocal";
import type { StepInvoker } from "@intx/workflow/runtime";
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
// pulls a top-level field off the evaluated input (`{ from }`) or a constant
// (`{ literal }`). Used to prove the mail/artifact argMaps resolve against a real
// merged step input, not just to snapshot the static tag.
function resolveArgMap(
  argMap: Record<string, { from: string } | { literal: unknown }>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(argMap)) {
    if ("from" in spec) {
      out[key] = input[spec.from];
    } else {
      out[key] = spec.literal;
    }
  }
  return out;
}

function argMapOf(
  id: string,
): Record<string, { from: string } | { literal: unknown }> {
  const tag = stepPrimitive(id).agent.tags?.[STEP_ARGMAP_TAG];
  if (tag === undefined) throw new Error(`expected argMap tag on step "${id}"`);
  return JSON.parse(tag);
}

const TRIGGER_PAYLOAD = {
  reason: "scheduled-heartbeat",
  userAddress: "usr_abc123@workbench.local",
  userRefId: "usr_abc123",
  createdAfter: "2026-07-04T00:00:00Z",
};

describe("heartbeat native workflow", () => {
  // -------------------------------------------------------------------------
  // Gate-free (load-bearing): no awaitSignal anywhere
  // -------------------------------------------------------------------------
  test("has no awaitSignal steps — every step is a plain step or map", () => {
    const kinds = Object.values(workflow.steps).map((s) => s.kind);
    expect(kinds.length).toBe(3 + WIRED_BRIEF_SOURCES.length);
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
    expect(nonIntakeSteps.sort()).toEqual(["brief", "notify", "persist"]);
  });

  test("each generated intake step is a deterministic call to its source's tool, nonFatal, with no inference source", () => {
    for (const source of WIRED_BRIEF_SOURCES) {
      const intake = stepPrimitive(heartbeatIntakeStepKey(source.key));
      expect(intake.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
      expect(intake.agent.tags?.[STEP_TOOL_TAG]).toContain(source.tool);
      expect(intake.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
      expect(intake.agent.inference.sources).toEqual([]);
      expect(intake.input).toEqual({ from: "trigger.payload" });
      expect(intake.after).toBeUndefined();
    }
  });

  // Load-bearing: today's catalog (Granola only) must generate a step graph
  // behaviorally identical to the old hand-written definition — one intake
  // step calling granola_list_notes, nonFatal, with brief depending on it.
  test("today's catalog (Granola only) generates the same graph shape as the hand-written v0", () => {
    expect(WIRED_BRIEF_SOURCES.map((s) => s.key)).toEqual(["granola"]);
    const intake = stepPrimitive(heartbeatIntakeStepKey("granola"));
    expect(intake.agent.id).toBe("heartbeat-intake-granola");
    expect(intake.agent.tags?.[STEP_TOOL_TAG]).toContain("granola_list_notes");
    expect(intake.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
    expect(stepPrimitive("brief").after).toEqual(["intake-granola"]);
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
  test("every intake step reads the trigger payload verbatim", () => {
    for (const source of WIRED_BRIEF_SOURCES) {
      expect(stepPrimitive(heartbeatIntakeStepKey(source.key)).input).toEqual(
        { from: "trigger.payload" },
      );
    }
  });

  test("brief merges the trigger payload and every intake step's output, and depends on all of them", () => {
    const intakeStepIds = WIRED_BRIEF_SOURCES.map((s) =>
      heartbeatIntakeStepKey(s.key),
    );
    expect(stepPrimitive("brief").input).toEqual({
      merge: [
        { from: "trigger.payload" },
        ...intakeStepIds.map((stepId) => ({ from: `steps.${stepId}.output` })),
      ],
    });
    expect(stepPrimitive("brief").after).toEqual(intakeStepIds);
  });

  // -------------------------------------------------------------------------
  // Mail addressing argMap
  // -------------------------------------------------------------------------
  test("notify argMap addresses the mail to the firing user with the brief as content", () => {
    expect(argMapOf("notify")).toEqual({
      to: { from: "userAddress" },
      subject: { literal: "Your morning brief" },
      content: { from: "reply" },
    });
  });

  // -------------------------------------------------------------------------
  // Artifact persistence argMap
  // -------------------------------------------------------------------------
  test("persist argMap saves the brief body as a report artifact", () => {
    expect(argMapOf("persist")).toEqual({
      title: { literal: "Morning Brief" },
      body: { from: "reply" },
      kind: { literal: "report" },
      jobLabel: { literal: "Morning Brief" },
    });
  });

  // -------------------------------------------------------------------------
  // Full run — completes with ZERO signals (proves gate-free / unattended)
  // -------------------------------------------------------------------------
  test("runs intake → brief → notify → persist to completion with no human input", async () => {
    const briefReply =
      "# Morning brief\n\n## What happened\n- Discovery call with Acme.";
    const { invoker, ran } = makeRecordingInvoker({
      "heartbeat-intake-granola": {
        notes: [{ id: "note_1", title: "Acme call", summary: "Discovery" }],
      },
      "heartbeat-brief": { reply: briefReply },
      "heartbeat-notify": { messageId: "mail_1" },
      "heartbeat-persist": { artifactId: "art_1", version: 1 },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      triggerPayload: TRIGGER_PAYLOAD,
    });

    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");

    const ranIds = ran.map((r) => r.id);
    expect(ranIds).toContain("heartbeat-intake-granola");
    expect(ranIds).toContain("heartbeat-brief");
    expect(ranIds).toContain("heartbeat-notify");
    expect(ranIds).toContain("heartbeat-persist");
  });

  // -------------------------------------------------------------------------
  // Integration seam — the mail step's decoded args carry the firing user's
  // usr_ address and the brief body; the artifact persists the same brief.
  // -------------------------------------------------------------------------
  test("mail_send receives the firing user's usr_ address and the artifact persists the brief", async () => {
    const briefReply = "# Morning brief\n\nAll clear today.";
    const { invoker, ran } = makeRecordingInvoker({
      "heartbeat-intake-granola": { notes: [] },
      "heartbeat-brief": { reply: briefReply },
      "heartbeat-notify": { messageId: "mail_1" },
      "heartbeat-persist": { artifactId: "art_1", version: 1 },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      triggerPayload: TRIGGER_PAYLOAD,
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    const notifyInput = ran.find((r) => r.id === "heartbeat-notify")?.input as
      | Record<string, unknown>
      | undefined;
    if (notifyInput === undefined) throw new Error("notify step did not run");

    const mailArgs = resolveArgMap(argMapOf("notify"), notifyInput);
    expect(mailArgs.to).toBe(TRIGGER_PAYLOAD.userAddress);
    expect(String(mailArgs.to).startsWith("usr_")).toBe(true);
    expect(mailArgs.subject).toBe("Your morning brief");
    expect(mailArgs.content).toBe(briefReply);

    const persistInput = ran.find((r) => r.id === "heartbeat-persist")
      ?.input as Record<string, unknown> | undefined;
    if (persistInput === undefined) throw new Error("persist step did not run");

    const artifactArgs = resolveArgMap(argMapOf("persist"), persistInput);
    expect(artifactArgs.body).toBe(briefReply);
    expect(artifactArgs.kind).toBe("report");
    expect(artifactArgs.title).toBe("Morning Brief");
  });
});
