import { describe, expect, test } from "bun:test";
import { runLocal } from "@intx/workflow/runlocal";
import type { ActionHandler } from "@intx/workflow";
import type { StepInvoker } from "@intx/workflow/runtime";
import {
  DETERMINISTIC_TOOL_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_NONFATAL_TAG,
  STEP_TOOL_TAG,
} from "@workbench/agents";

import {
  workflow,
  DOCUMENT_HANDLER,
  PACKAGE_ARTIFACT_HANDLER,
  TECH_STACK_HANDLER,
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

function stepPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected step primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
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

function mapPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "map") {
    throw new Error(
      `expected map primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

const AGENT_REPLY = (reply: string): { reply: string } => ({ reply });

describe("sumble-account-intel workflow structure", () => {
  test("declares the expected step keys in order", () => {
    expect(Object.keys(workflow.steps)).toEqual([
      "intake",
      "resolve",
      "teams",
      "jobs",
      "techStack",
      "contacts",
      "signals",
      "enrichSocial",
      "synthesize",
      "review",
      "document",
      "packageArtifact",
    ]);
  });

  test("intake and review are awaitSignal gates with the expected names", () => {
    const intake = workflow.steps.intake;
    if (!intake || intake.kind !== "awaitSignal")
      throw new Error("expected intake awaitSignal");
    expect(intake.name).toBe("intake");

    const review = workflow.steps.review;
    if (!review || review.kind !== "awaitSignal")
      throw new Error("expected review awaitSignal");
    expect(review.name).toBe("review");
  });

  test("deterministic steps reference the expected Sumble tool names", () => {
    const expected: Record<string, string> = {
      resolve: "sumble_resolve_organization",
      teams: "sumble_list_teams",
      jobs: "sumble_list_jobs",
      contacts: "sumble_search_people",
      signals: "sumble_search_signals",
    };
    for (const [stepId, tool] of Object.entries(expected)) {
      const step = stepPrimitive(stepId);
      expect(step.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
      expect(step.agent.tags?.[STEP_TOOL_TAG]).toContain(tool);
      expect(step.agent.inference.sources).toEqual([]);
    }
  });

  test("resolve routes the single intake identifier through the tool's classifier", () => {
    const argMap = stepPrimitive("resolve").agent.tags?.[STEP_ARGMAP_TAG];
    if (argMap === undefined)
      throw new Error("expected argMap on resolve step");
    // A single field routed to `identifier` — NOT dual domain+slug (which sent a
    // slug as the wrong ref field). The tool classifies domain vs slug by shape.
    expect(JSON.parse(argMap)).toEqual({
      identifier: { from: "organizationDomain" },
    });
  });

  test("downstream Sumble steps read the resolved org's structured content", () => {
    for (const stepId of ["teams", "jobs", "contacts", "signals"]) {
      expect(stepPrimitive(stepId).input).toEqual({
        from: "steps.resolve.output.content",
      });
    }
  });

  test("techStack is a native action reading the resolved org's slug directly (no rename needed)", () => {
    const techStack = actionPrimitive("techStack");
    expect(techStack.handler).toBe(TECH_STACK_HANDLER);
    expect(techStack.input).toEqual({
      merge: [
        {
          project: { from: "steps.resolve.output.content" },
          fields: ["slug"],
        },
        { literal: { limit: 25 } },
      ],
    });
    expect(techStack.effect).toEqual({ requires: [TECH_STACK_HANDLER] });
    expect("agent" in techStack).toBe(false);
  });

  test("the bounded Sumble steps cap per-call cost with limit 25", () => {
    for (const stepId of ["teams", "jobs", "signals"]) {
      const argMap = stepPrimitive(stepId).agent.tags?.[STEP_ARGMAP_TAG];
      if (argMap === undefined)
        throw new Error(`expected argMap on ${stepId} step`);
      expect(JSON.parse(argMap).limit).toEqual({ literal: 25 });
    }
  });

  test("the best-effort Sumble steps are marked non-fatal", () => {
    for (const stepId of ["teams", "jobs", "signals"]) {
      expect(stepPrimitive(stepId).agent.tags?.[STEP_NONFATAL_TAG]).toBe(
        "true",
      );
    }
    // resolve and contacts are load-bearing (the run and the enrichment map
    // depend on their structured output) — NOT non-fatal.
    for (const stepId of ["resolve", "contacts"]) {
      expect(
        stepPrimitive(stepId).agent.tags?.[STEP_NONFATAL_TAG],
      ).toBeUndefined();
    }
  });

  test("enrichSocial is a map over the contacts people array running a non-fatal x_search", () => {
    const enrich = mapPrimitive("enrichSocial");
    expect(enrich.over).toEqual({
      from: "steps.contacts.output.content.people",
    });
    const inner = enrich.step;
    expect(inner.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(inner.agent.tags?.[STEP_TOOL_TAG]).toContain("x_search");
    expect(inner.agent.tags?.[STEP_NONFATAL_TAG]).toBe("true");
    expect(inner.input).toEqual({ from: "trigger.payload" });
    const argMap = inner.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMap === undefined)
      throw new Error("expected argMap on x_search step");
    expect(JSON.parse(argMap)).toEqual({
      query: { from: "name" },
      limit: { literal: 5 },
    });
  });

  test("synthesize is a native reasoning step (agentStep) with a real prompt and no tools", () => {
    const synth = stepPrimitive("synthesize");
    expect(synth.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(synth.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(synth.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(synth.input).toEqual({ from: "steps" });
  });

  test("document is a native action pairing organizationDomain and the synthesize agent's reply into { title, body }", () => {
    const document = actionPrimitive("document");
    expect(document.handler).toBe(DOCUMENT_HANDLER);
    expect(document.input).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.synthesize.output" },
      ],
    });
    expect(document.effect).toEqual({ requires: [DOCUMENT_HANDLER] });
    expect("agent" in document).toBe(false);
  });

  test("packageArtifact is a native action persisting via write_artifact", () => {
    const pkg = actionPrimitive("packageArtifact");
    expect(pkg.handler).toBe(PACKAGE_ARTIFACT_HANDLER);
    expect(pkg.input).toEqual({
      merge: [
        { from: "steps.document.output.content" },
        { from: "steps.review.output" },
        { literal: { kind: "research", jobLabel: "Sumble account intel" } },
      ],
    });
    expect(pkg.effect).toEqual({ requires: [PACKAGE_ARTIFACT_HANDLER] });
    expect("agent" in pkg).toBe(false);
  });

  test("step `after` dependencies chain as specified", () => {
    expect(stepPrimitive("resolve").after).toEqual(["intake"]);
    expect(stepPrimitive("teams").after).toEqual(["resolve"]);
    expect(stepPrimitive("jobs").after).toEqual(["teams"]);
    expect(actionPrimitive("techStack").after).toEqual(["jobs"]);
    expect(stepPrimitive("contacts").after).toEqual(["techStack"]);
    expect(stepPrimitive("signals").after).toEqual(["contacts"]);
    expect(mapPrimitive("enrichSocial").after).toEqual(["signals"]);
    expect(stepPrimitive("synthesize").after).toEqual(["enrichSocial"]);
    const review = workflow.steps.review;
    if (!review || review.kind !== "awaitSignal")
      throw new Error("expected review awaitSignal");
    expect(review.after).toEqual(["synthesize"]);
    expect(actionPrimitive("document").after).toEqual(["synthesize"]);
    expect(actionPrimitive("packageArtifact").after).toEqual([
      "document",
      "review",
    ]);
  });
});

describe("sumble-account-intel workflow execution", () => {
  test("runs the full flow intake → research → enrichSocial map → synthesize → review → packageArtifact", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      // The REAL shapes the fixed tools produce: resolve exposes the matched org
      // record as structured content; search_people exposes { people, count }.
      "sumble-account-intel-resolve": {
        content: { slug: "acme", url: "acme.com" },
      },
      "sumble-account-intel-contacts": {
        content: {
          people: [{ name: "Ada Lovelace" }, { name: "Alan Turing" }],
          count: 2,
        },
      },
      "sumble-account-intel-enrich-social": { content: "[]" },
      "sumble-account-intel-synthesize": AGENT_REPLY(
        JSON.stringify({
          title: "Acme — account brief",
          content: "## Account summary\nAcme builds things.",
          contactsCsv: "name,title,email,x_handle\nAda Lovelace,,,",
          slackDraft: "Acme is worth a look.",
        }),
      ),
    });
    const { resolver, ran: actionsRan } = makeRecordingActionResolver({
      [TECH_STACK_HANDLER]: { content: "{}" },
      [DOCUMENT_HANDLER]: {
        content: { title: "acme.com", body: "## Account summary" },
      },
      [PACKAGE_ARTIFACT_HANDLER]: {
        content: JSON.stringify({ artifactId: "art_1" }),
      },
    });

    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });
    await run.signal("intake", { organizationDomain: "acme.com" });
    await run.signal("review", { approved: true, pushToAttio: false });
    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");

    const ranIds = ran.map((r) => r.id);
    expect(ranIds).toContain("sumble-account-intel-resolve");
    expect(ranIds).toContain("sumble-account-intel-contacts");
    // The map ran once per contact in the contacts output content array.
    expect(
      ran.filter((r) => r.id === "sumble-account-intel-enrich-social"),
    ).toHaveLength(2);
    expect(ranIds).toContain("sumble-account-intel-synthesize");
    const actionRefs = actionsRan.map((r) => r.handler);
    expect(actionRefs).toContain(TECH_STACK_HANDLER);
    expect(actionRefs).toContain(DOCUMENT_HANDLER);
    expect(actionRefs).toContain(PACKAGE_ARTIFACT_HANDLER);
  });

  test("blocks at the review gate until the review signal arrives", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "sumble-account-intel-resolve": {
        content: { slug: "acme" },
      },
      "sumble-account-intel-contacts": { content: { people: [], count: 0 } },
      "sumble-account-intel-synthesize": AGENT_REPLY(
        JSON.stringify({
          title: "t",
          content: "c",
          contactsCsv: "name,title,email,x_handle",
          slackDraft: "s",
        }),
      ),
    });
    const { resolver, ran: actionsRan } = makeRecordingActionResolver({
      [TECH_STACK_HANDLER]: { content: "{}" },
      [DOCUMENT_HANDLER]: {
        content: { title: "acme.com", body: "c" },
      },
    });
    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });
    await run.signal("intake", { organizationDomain: "acme.com" });

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (ran.some((r) => r.id === "sumble-account-intel-synthesize")) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    // packageArtifact must NOT have run — blocked on the review signal.
    expect(actionsRan.some((r) => r.handler === PACKAGE_ARTIFACT_HANDLER)).toBe(
      false,
    );

    await run.signal("review", { approved: true });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
  });
});
