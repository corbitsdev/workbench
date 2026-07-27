import { describe, expect, test } from "bun:test";
import { runLocal } from "@intx/workflow/runlocal";
import type { ActionHandler } from "@intx/workflow";
import type { StepInvoker } from "@intx/workflow/runtime";

import {
  workflow,
  DOCUMENT_HANDLER,
  ENRICH_CONTACTS_HANDLER,
  LIST_JOBS_HANDLER,
  LIST_TEAMS_HANDLER,
  PACKAGE_ARTIFACT_HANDLER,
  RESOLVE_ORGANIZATION_HANDLER,
  REVIEW_GATE_HANDLER,
  SEARCH_PEOPLE_HANDLER,
  SEARCH_SIGNALS_HANDLER,
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

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
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

const AGENT_REPLY = (reply: string): { reply: string } => ({ reply });

const SLUG_PROJECTION = (limit: number) => ({
  merge: [
    { project: { from: "steps.resolve.output.content" }, fields: ["slug"] },
    { literal: { limit } },
  ],
});

const BRIEF_JSON = JSON.stringify({
  title: "Acme — account brief",
  content: "## Account summary\nAcme builds things.",
  contactsCsv: "name,title,email,x_handle\nAda Lovelace,,,",
  slackDraft: "Acme is worth a look.",
});

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
      "reviewGate",
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

  test("resolve is a native action reading the whole intake output verbatim (no rename needed — the wrapper's own field is organizationDomain)", () => {
    const resolve = actionPrimitive("resolve");
    expect(resolve.handler).toBe(RESOLVE_ORGANIZATION_HANDLER);
    expect(resolve.input).toEqual({ from: "steps.intake.output" });
    expect(resolve.effect).toEqual({
      requires: [RESOLVE_ORGANIZATION_HANDLER],
    });
    expect("agent" in resolve).toBe(false);
  });

  test("teams/jobs/signals/contacts are native actions projecting the resolved org's slug (no rename needed)", () => {
    expect(actionPrimitive("teams").handler).toBe(LIST_TEAMS_HANDLER);
    expect(actionPrimitive("teams").input).toEqual(SLUG_PROJECTION(25));
    expect(actionPrimitive("teams").effect).toEqual({
      requires: [LIST_TEAMS_HANDLER],
    });

    expect(actionPrimitive("jobs").handler).toBe(LIST_JOBS_HANDLER);
    expect(actionPrimitive("jobs").input).toEqual(SLUG_PROJECTION(25));
    expect(actionPrimitive("jobs").effect).toEqual({
      requires: [LIST_JOBS_HANDLER],
    });

    expect(actionPrimitive("signals").handler).toBe(SEARCH_SIGNALS_HANDLER);
    expect(actionPrimitive("signals").input).toEqual(SLUG_PROJECTION(25));
    expect(actionPrimitive("signals").effect).toEqual({
      requires: [SEARCH_SIGNALS_HANDLER],
    });

    expect(actionPrimitive("contacts").handler).toBe(SEARCH_PEOPLE_HANDLER);
    expect(actionPrimitive("contacts").input).toEqual(SLUG_PROJECTION(10));
    expect(actionPrimitive("contacts").effect).toEqual({
      requires: [SEARCH_PEOPLE_HANDLER],
    });

    for (const id of ["teams", "jobs", "signals", "contacts"]) {
      expect("agent" in actionPrimitive(id)).toBe(false);
    }
  });

  test("techStack is a native action reading the resolved org's slug directly (no rename needed)", () => {
    const techStack = actionPrimitive("techStack");
    expect(techStack.handler).toBe(TECH_STACK_HANDLER);
    expect(techStack.input).toEqual(SLUG_PROJECTION(25));
    expect(techStack.effect).toEqual({ requires: [TECH_STACK_HANDLER] });
    expect("agent" in techStack).toBe(false);
  });

  test("enrichSocial is a native action folding the former map — no map primitive remains", () => {
    const enrich = actionPrimitive("enrichSocial");
    expect(enrich.handler).toBe(ENRICH_CONTACTS_HANDLER);
    expect(enrich.input).toEqual({ from: "steps.contacts.output.content" });
    // Sibling pins @workbench/tools-x so the xai credential is allow-listed
    // (and does not 403 the whole sumble+xai batch). Assert the whole
    // canonical string: a wrong package prefix pins nothing.
    expect(enrich.effect).toEqual({
      requires: [
        ENRICH_CONTACTS_HANDLER,
        "@workbench/tools-x/x:x_search",
      ],
    });
    expect("agent" in enrich).toBe(false);
    // No step in this workflow is a `map` primitive anymore.
    for (const primitive of Object.values(workflow.steps)) {
      expect(primitive.kind).not.toBe("map");
    }
  });

  test("synthesize is a native reasoning step (inlined step+defineAgent) with a real prompt and no tools", () => {
    const synth = stepPrimitive("synthesize");
    expect(synth.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(synth.input).toEqual({ from: "steps" });
  });

  test("reviewGate is a native action shaping the synthesize reply into the review gate's UIBlock", () => {
    const gate = actionPrimitive("reviewGate");
    expect(gate.handler).toBe(REVIEW_GATE_HANDLER);
    expect(gate.input).toEqual({ from: "steps.synthesize.output" });
    expect(gate.effect).toEqual({ requires: [REVIEW_GATE_HANDLER] });
    expect("agent" in gate).toBe(false);
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
    expect(actionPrimitive("resolve").after).toEqual(["intake"]);
    expect(actionPrimitive("teams").after).toEqual(["resolve"]);
    expect(actionPrimitive("jobs").after).toEqual(["teams"]);
    expect(actionPrimitive("techStack").after).toEqual(["jobs"]);
    expect(actionPrimitive("contacts").after).toEqual(["techStack"]);
    expect(actionPrimitive("signals").after).toEqual(["contacts"]);
    expect(actionPrimitive("enrichSocial").after).toEqual(["signals"]);
    expect(stepPrimitive("synthesize").after).toEqual(["enrichSocial"]);
    expect(actionPrimitive("reviewGate").after).toEqual(["synthesize"]);
    const review = workflow.steps.review;
    if (!review || review.kind !== "awaitSignal")
      throw new Error("expected review awaitSignal");
    expect(review.after).toEqual(["reviewGate"]);
    expect(actionPrimitive("document").after).toEqual(["synthesize"]);
    expect(actionPrimitive("packageArtifact").after).toEqual([
      "document",
      "review",
    ]);
  });
});

describe("sumble-account-intel workflow execution", () => {
  test("runs the full flow intake → research (all native actions) → synthesize → reviewGate → review → packageArtifact", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "sumble-account-intel-synthesize": AGENT_REPLY(BRIEF_JSON),
    });
    const { resolver, ran: actionsRan } = makeRecordingActionResolver({
      [RESOLVE_ORGANIZATION_HANDLER]: {
        content: { slug: "acme", url: "acme.com" },
      },
      [LIST_TEAMS_HANDLER]: { content: { ok: true, data: { teams: [] } } },
      [LIST_JOBS_HANDLER]: { content: { ok: true, data: { jobs: [] } } },
      [SEARCH_PEOPLE_HANDLER]: {
        content: {
          people: [{ name: "Ada Lovelace" }, { name: "Alan Turing" }],
          count: 2,
        },
      },
      [TECH_STACK_HANDLER]: { content: "{}" },
      [SEARCH_SIGNALS_HANDLER]: {
        content: { ok: true, data: { signals: [] } },
      },
      [ENRICH_CONTACTS_HANDLER]: {
        content: { people: [{ ok: true, data: "[]", name: "Ada Lovelace" }] },
      },
      [REVIEW_GATE_HANDLER]: {
        content: {
          kind: "choice",
          prompt: "review this",
          options: [
            {
              id: "approve",
              label: "Approve & save",
              payload: { approved: true },
            },
            { id: "reject", label: "Reject", payload: { approved: false } },
          ],
        },
      },
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

    const actionRefs = actionsRan.map((r) => r.handler);
    expect(actionRefs).toContain(RESOLVE_ORGANIZATION_HANDLER);
    expect(actionRefs).toContain(LIST_TEAMS_HANDLER);
    expect(actionRefs).toContain(LIST_JOBS_HANDLER);
    expect(actionRefs).toContain(SEARCH_PEOPLE_HANDLER);
    expect(actionRefs).toContain(SEARCH_SIGNALS_HANDLER);
    expect(actionRefs).toContain(ENRICH_CONTACTS_HANDLER);
    expect(actionRefs).toContain(TECH_STACK_HANDLER);
    expect(actionRefs).toContain(REVIEW_GATE_HANDLER);
    expect(actionRefs).toContain(DOCUMENT_HANDLER);
    expect(actionRefs).toContain(PACKAGE_ARTIFACT_HANDLER);
    const ranIds = ran.map((r) => r.id);
    expect(ranIds).toContain("sumble-account-intel-synthesize");
  });

  test("a degraded (ok:false) facet output does not stop synthesize from running — the run still completes", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "sumble-account-intel-synthesize": AGENT_REPLY(
        JSON.stringify({
          title: "t",
          content: "c",
          contactsCsv: "name,title,email,x_handle",
          slackDraft: "s",
        }),
      ),
    });
    const { resolver } = makeRecordingActionResolver({
      [RESOLVE_ORGANIZATION_HANDLER]: { content: { slug: "acme" } },
      // teams/jobs/signals all report a degraded facet — none of this
      // throws or sets an outer isError, so the action dispatch never fails
      // the step (see tools.test.ts for the wrapper-level proof).
      [LIST_TEAMS_HANDLER]: {
        content: { ok: false, error: "teams exploded" },
      },
      [LIST_JOBS_HANDLER]: { content: { ok: false, error: "jobs exploded" } },
      [SEARCH_SIGNALS_HANDLER]: {
        content: { ok: false, error: "signals exploded" },
      },
      [SEARCH_PEOPLE_HANDLER]: { content: { people: [], count: 0 } },
      [TECH_STACK_HANDLER]: { content: "{}" },
      [ENRICH_CONTACTS_HANDLER]: { content: { people: [] } },
      [REVIEW_GATE_HANDLER]: {
        content: {
          kind: "choice",
          options: [
            {
              id: "approve",
              label: "Approve & save",
              payload: { approved: true },
            },
            { id: "reject", label: "Reject", payload: { approved: false } },
          ],
        },
      },
      [DOCUMENT_HANDLER]: { content: { title: "acme.com", body: "c" } },
      [PACKAGE_ARTIFACT_HANDLER]: {
        content: JSON.stringify({ artifactId: "art_1" }),
      },
    });
    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: resolver,
    });
    await run.signal("intake", { organizationDomain: "acme.com" });
    await run.signal("review", { approved: true });
    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");
    expect(ran.some((r) => r.id === "sumble-account-intel-synthesize")).toBe(
      true,
    );
  });

  test("a fatal resolve failure fails the whole run rather than continuing", async () => {
    // `resolve` failing does not by itself halt the DAG: only steps whose OWN
    // input selector dereferences `steps.resolve.output` (teams/jobs/
    // techStack/contacts/signals) fail in cascade; `synthesize`'s `{ from:
    // "steps" }` selector tolerates a missing/failed sibling, so the run
    // still drains through review and persistence. The runtime settles the
    // RUN's terminal status only once every step is terminal
    // (`isRunDone`/`hasFailedStep` in `interchange/packages/workflow/src/
    // runtime/dag.ts`) — a permanently-`failed` `resolve` step still marks
    // the whole run `RunFailed` at that point, so the review signal must be
    // delivered too for the run to actually reach its terminal state.
    const { invoker } = makeRecordingInvoker({
      "sumble-account-intel-synthesize": AGENT_REPLY(BRIEF_JSON),
    });
    const { resolver } = makeRecordingActionResolver({
      [REVIEW_GATE_HANDLER]: {
        content: {
          kind: "choice",
          options: [
            {
              id: "approve",
              label: "Approve & save",
              payload: { approved: true },
            },
            { id: "reject", label: "Reject", payload: { approved: false } },
          ],
        },
      },
      [DOCUMENT_HANDLER]: { content: { title: "explodes.com", body: "c" } },
      [PACKAGE_ARTIFACT_HANDLER]: {
        content: JSON.stringify({ artifactId: "art_1" }),
      },
    });
    const failingResolver = (ref: string): ActionHandler => {
      if (ref === RESOLVE_ORGANIZATION_HANDLER) {
        return async () => {
          throw new Error("resolve exploded");
        };
      }
      return resolver(ref);
    };
    const run = runLocal(workflow, {
      invokeStep: invoker,
      actionResolver: failingResolver,
    });
    await run.signal("intake", { organizationDomain: "explodes.com" });
    await run.signal("review", { approved: true });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("failed");
    const resolveFailed = result.events.find(
      (e) => e.kind === "StepFailed" && e.stepId === "resolve",
    );
    expect(resolveFailed).toBeDefined();
    // teams/jobs/techStack/contacts/signals/enrichSocial all cascade-fail
    // from the missing `steps.resolve.output` their own selectors read —
    // none of them ever dispatched a real tool call.
    for (const stepId of [
      "teams",
      "jobs",
      "techStack",
      "contacts",
      "signals",
      "enrichSocial",
    ]) {
      const failed = result.events.find(
        (e) => e.kind === "StepFailed" && e.stepId === stepId,
      );
      expect(failed).toBeDefined();
    }
  });

  test("blocks at the review gate until the review signal arrives", async () => {
    const { invoker, ran } = makeRecordingInvoker({
      "sumble-account-intel-synthesize": AGENT_REPLY(BRIEF_JSON),
    });
    const { resolver, ran: actionsRan } = makeRecordingActionResolver({
      [RESOLVE_ORGANIZATION_HANDLER]: { content: { slug: "acme" } },
      [LIST_TEAMS_HANDLER]: { content: { ok: true, data: {} } },
      [LIST_JOBS_HANDLER]: { content: { ok: true, data: {} } },
      [SEARCH_SIGNALS_HANDLER]: { content: { ok: true, data: {} } },
      [SEARCH_PEOPLE_HANDLER]: { content: { people: [], count: 0 } },
      [TECH_STACK_HANDLER]: { content: "{}" },
      [ENRICH_CONTACTS_HANDLER]: { content: { people: [] } },
      [REVIEW_GATE_HANDLER]: {
        content: {
          kind: "choice",
          options: [
            {
              id: "approve",
              label: "Approve & save",
              payload: { approved: true },
            },
            { id: "reject", label: "Reject", payload: { approved: false } },
          ],
        },
      },
      [DOCUMENT_HANDLER]: { content: { title: "acme.com", body: "c" } },
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
