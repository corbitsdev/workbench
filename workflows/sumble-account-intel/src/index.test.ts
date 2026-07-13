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

import { workflow } from "./index";

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
      `expected step primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
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
      techStack: "sumble_get_org_tech_stack",
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
    for (const stepId of [
      "teams",
      "jobs",
      "techStack",
      "contacts",
      "signals",
    ]) {
      expect(stepPrimitive(stepId).input).toEqual({
        from: "steps.resolve.output.content",
      });
    }
  });

  test("the bounded Sumble steps cap per-call cost with limit 25", () => {
    for (const stepId of ["teams", "jobs", "techStack", "signals"]) {
      const argMap = stepPrimitive(stepId).agent.tags?.[STEP_ARGMAP_TAG];
      if (argMap === undefined)
        throw new Error(`expected argMap on ${stepId} step`);
      expect(JSON.parse(argMap).limit).toEqual({ literal: 25 });
    }
  });

  test("the best-effort Sumble steps are marked non-fatal", () => {
    for (const stepId of ["teams", "jobs", "techStack", "signals"]) {
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

  test("synthesize is an inline-inference step with a real prompt and no tools", () => {
    const synth = stepPrimitive("synthesize");
    expect(synth.agent.tags?.[STEP_KIND_TAG]).toBe(INLINE_INFERENCE_KIND);
    expect(synth.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(synth.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(synth.input).toEqual({ from: "steps" });
  });

  test("packageArtifact persists via write_artifact with the research argMap", () => {
    const pkg = stepPrimitive("packageArtifact");
    expect(pkg.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(pkg.agent.tags?.[STEP_TOOL_TAG]).toContain("write_artifact");
    const argMap = pkg.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMap === undefined)
      throw new Error("expected argMap on packageArtifact");
    expect(JSON.parse(argMap)).toEqual({
      title: { from: "organizationDomain" },
      body: { from: "reply" },
      kind: { literal: "research" },
      jobLabel: { literal: "Sumble account intel" },
    });
  });

  test("step `after` dependencies chain as specified", () => {
    expect(stepPrimitive("resolve").after).toEqual(["intake"]);
    expect(stepPrimitive("teams").after).toEqual(["resolve"]);
    expect(stepPrimitive("jobs").after).toEqual(["teams"]);
    expect(stepPrimitive("techStack").after).toEqual(["jobs"]);
    expect(stepPrimitive("contacts").after).toEqual(["techStack"]);
    expect(stepPrimitive("signals").after).toEqual(["contacts"]);
    expect(mapPrimitive("enrichSocial").after).toEqual(["signals"]);
    expect(stepPrimitive("synthesize").after).toEqual(["enrichSocial"]);
    const review = workflow.steps.review;
    if (!review || review.kind !== "awaitSignal")
      throw new Error("expected review awaitSignal");
    expect(review.after).toEqual(["synthesize"]);
    expect(stepPrimitive("packageArtifact").after).toEqual(["review"]);
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
      "sumble-account-intel-package": {
        content: JSON.stringify({ artifactId: "art_1" }),
      },
    });

    const run = runLocal(workflow, { invokeStep: invoker });
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
    expect(ranIds).toContain("sumble-account-intel-package");
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
    const run = runLocal(workflow, { invokeStep: invoker });
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
    expect(ran.some((r) => r.id === "sumble-account-intel-package")).toBe(
      false,
    );

    await run.signal("review", { approved: true });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");
  });
});
