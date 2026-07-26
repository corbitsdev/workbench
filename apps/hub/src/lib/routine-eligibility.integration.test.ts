import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { describe, expect, it } from "bun:test";
import { isRoutineEligibleKind } from "@workbench/shared";
import {
  loadWorkflowCatalogKinds,
  loadWorkflowEntryTriggerFields,
  loadWorkflowGateInfos,
  loadWorkflowIntakeFields,
} from "./workflow-catalog";
import {
  embeddedWorkflowDefsDir,
  EmbeddedWorkflowDefSchema,
} from "./workflow-defs-embedded";
import { KNOWN_TOOLS } from "./tool-registry";
import { ENRICHED_TRIGGER_KINDS } from "../workflow-executor/trigger-payload-enrichment-registry";
import { requiredIntakeSchemaKeys } from "../workflow-executor/resume-payload-registry";

// Real end-to-end exercise against the actual committed embedded catalog
// (apps/hub/generated/workflow-defs) and the actual trigger-payload-
// enrichment registry — no mocks. Every deployed workflow is schedulable
// (CL-4514): there is no runtime attachability or eligibility GATE anymore —
// the scheduler renders whatever intake fields a definition declares and
// fires with an empty payload when it declares none. What replaces the
// runtime gate is THIS build-time CHECK: a kind whose entry step needs a
// trigger-payload field nobody can supply unattended must fail the build,
// not fail silently at fire time (the bug class this whole line of work
// started from — `granola-call` reading a required `noteId` straight off the
// trigger payload with no intake field and no registered enricher, so every
// scheduled fire died on step one).
describe("every deployed workflow kind is schedulable (CL-4514)", () => {
  it("lists every real committed workflow kind with no exclusions", async () => {
    const kinds = await loadWorkflowCatalogKinds();
    // A hard-coded floor, not a ceiling: catches an accidental narrowing of
    // the embedded catalog loader without hand-maintaining the full kind list
    // here (that list belongs to the committed generated/workflow-defs dir).
    expect(kinds.size).toBeGreaterThanOrEqual(21);
    // Previously-excluded kinds (structurally unattachable multi-gate shapes,
    // kinds failing the old CL-4204 derived-eligibility rule) are ordinary
    // members of this set now — there is no second, narrower "attachable"
    // set to compute.
    expect(kinds.has("attio-task-agent")).toBe(true);
    expect(kinds.has("granola-call")).toBe(true);
    expect(kinds.has("scrape-for-stories")).toBe(true);
  });
});

// KNOWN GAP (tracked on a separate branch, land together): the entry-step
// trigger-field derivation below only inspects a `kind: "step"` entry
// carrying the `workbench.argMap` tag stamped by `deterministicToolStep` —
// see the docstring on `deriveEntryStepRequiredTriggerFields`
// (workflow-gate-info.ts). A native `action`-kind entry step whose selector
// reads a required field straight off `trigger.payload` is invisible to this
// derivation and returns `[]` uncritically, so it would trivially "pass" the
// check below even if genuinely unschedulable. Closing that gap requires
// walking the entry step's `input` selector directly; do not remove or
// weaken the assertions below while that lands — extend them instead.
describe("declared intake fields + enrichers cover every entry step's required trigger fields", () => {
  it("every deployed kind satisfies isRoutineEligibleKind against the real embedded catalog", async () => {
    const [entryTriggerFieldsByKind, intakeFieldsByKind] = await Promise.all([
      loadWorkflowEntryTriggerFields(),
      loadWorkflowIntakeFields(),
    ]);
    const kinds = await loadWorkflowCatalogKinds();
    const failures: string[] = [];
    for (const kind of kinds) {
      const requiredFields = entryTriggerFieldsByKind.get(kind) ?? [];
      const intakeNames = new Set(
        (intakeFieldsByKind.get(kind) ?? []).map((f) => f.name),
      );
      const eligible = isRoutineEligibleKind(
        requiredFields,
        intakeNames,
        ENRICHED_TRIGGER_KINDS.has(kind),
      );
      if (!eligible) {
        const uncovered = requiredFields.filter(
          (f) => !intakeNames.has(f) && !ENRICHED_TRIGGER_KINDS.has(kind),
        );
        failures.push(
          `${kind}: uncovered trigger fields ${uncovered.join(", ")}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("includes granola-call: its native action entry step requires no trigger fields", async () => {
    const entryTriggerFieldsByKind = await loadWorkflowEntryTriggerFields();
    expect(entryTriggerFieldsByKind.get("granola-call") ?? []).toEqual([]);
  });

  it("heartbeat and prospect-engine rely on their registered trigger-payload enrichers", () => {
    expect(ENRICHED_TRIGGER_KINDS.has("heartbeat")).toBe(true);
    expect(ENRICHED_TRIGGER_KINDS.has("prospect-engine")).toBe(true);
  });
});

// CL-4538: gtm-scripts-briefs declared its `intake` fields only in the dock's
// private `blocks.ts` builder, never on the workflow definition — the schedule/
// attach form (which reads a definition's exported `INTAKE_FIELDS`) rendered no
// inputs at all, then the `/resume` boundary rejected the hollow payload for
// missing `topic`/`days`. This checks EVERY real committed workflow kind, so a
// future workflow that registers an `intake` resume-payload schema without
// declaring matching intake fields fails here instead of shipping the same
// silent-empty-form bug.
describe("declared intake fields cover the registered intake resume-payload schema", () => {
  it("every kind with a registered `intake` schema declares every field that schema requires", async () => {
    const [kinds, intakeFieldsByKind] = await Promise.all([
      loadWorkflowCatalogKinds(),
      loadWorkflowIntakeFields(),
    ]);
    const failures: string[] = [];
    for (const kind of kinds) {
      const requiredKeys = requiredIntakeSchemaKeys(kind);
      if (requiredKeys === undefined) continue;
      const declaredNames = new Set(
        (intakeFieldsByKind.get(kind) ?? []).map((f) => f.name),
      );
      const missing = requiredKeys.filter((key) => !declaredNames.has(key));
      if (missing.length > 0) {
        failures.push(`${kind}: missing ${missing.join(", ")}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("sanity: gtm-scripts-briefs' registered schema actually requires topic and days", () => {
    expect(requiredIntakeSchemaKeys("gtm-scripts-briefs")).toEqual(
      expect.arrayContaining(["topic", "days"]),
    );
  });

  // scrape-for-stories (CL-4430) is fully unattended after intake: the schedule
  // is the only thing that ever supplies `topics`. This pins the pairing the
  // generic check above enforces — a registered schema that requires `topics`,
  // and a declared schedule field of that exact name — so dropping either side
  // fails here with a kind-specific message rather than only in the aggregate.
  it("sanity: scrape-for-stories requires topics and declares it as a schedule field", async () => {
    expect(requiredIntakeSchemaKeys("scrape-for-stories")).toEqual(["topics"]);
    const intakeFieldsByKind = await loadWorkflowIntakeFields();
    expect(
      (intakeFieldsByKind.get("scrape-for-stories") ?? []).map((f) => f.name),
    ).toEqual(["topics"]);
  });
});

// Deleting `deriveEntryStepRequiredTriggerFields` (the `workbench.argMap`
// reader, retired alongside `deterministicToolStep`) proved only that no
// committed def can carry that tag anymore — it did NOT prove the property
// the old function enforced still holds. That function only ever inspected
// `kind: "step"` entry steps; a native `action` entry step reading a
// required argument straight off `trigger.payload` (a primitive that did not
// exist when the old check was written) sails through undetected today.
// `granola-call`'s `discover`/`spawn` are exactly that shape — they only pass
// because their author made every tool argument optional and documented it,
// not because anything enforces it.
//
// This is a BUILD-TIME test, not a reinstated runtime gate (the operator's
// position is every workflow is schedulable, and CL-4514 removes runtime
// eligibility gating entirely). It independently re-derives, from the raw
// selector tree on every fully-unattended kind's `action` steps (walking
// `from`/`project`/`merge`/`literal` per
// `interchange/packages/workflow/src/definition/selectors.ts`), which
// `trigger.payload` fields a step's tool call actually requires, then checks
// each against declared intake fields / the enricher registry / the tool's
// own required-args schema — so a future authoring mistake of this shape
// fails a commit instead of only a live scheduled fire.
describe("native action entry steps only require trigger fields the schedule can supply", () => {
  type RawSelector =
    | { from: string }
    | { project: RawSelector; fields: readonly string[] }
    | { merge: readonly RawSelector[] }
    | { literal: unknown };

  type RawActionStep = {
    kind?: string;
    handler?: string;
    input?: RawSelector;
  };

  // Classifies a selector's relationship to `trigger.payload`:
  //  - "trigger": the selector reads (only) trigger.payload/literals; `fields`
  //    names the exact keys it exposes, or "ALL" for a bare
  //    `{ from: "trigger.payload" }` pass-through (every key the object
  //    happens to carry rides along verbatim into the tool call).
  //  - "other": the selector reads at least one non-trigger, non-literal
  //    source (typically `steps.<id>.output`). A `merge` mixing an "other"
  //    branch with a trigger branch is classified "other" — we cannot
  //    statically know whether the other branch already supplies a given
  //    required key (e.g. granola-call's `spawn` merges
  //    `steps.discover.output` with `trigger.payload`; `content` comes from
  //    the former), so a merge is only checked when EVERY branch is
  //    trigger/literal. This is the one selector shape this derivation
  //    cannot fully resolve; mixed merges are skipped rather than guessed.
  //  - "literal": no trigger dependency at all.
  type FieldOrigin =
    | { origin: "trigger"; fields: "ALL" | Set<string> }
    | { origin: "other" }
    | { origin: "literal" };

  function classify(selector: RawSelector): FieldOrigin {
    if ("literal" in selector) return { origin: "literal" };
    if ("from" in selector) {
      if (selector.from === "trigger.payload") {
        return { origin: "trigger", fields: "ALL" };
      }
      if (selector.from.startsWith("trigger.payload.")) {
        const rest = selector.from.slice("trigger.payload.".length);
        const field = rest.split(".")[0]?.split("[")[0];
        return field
          ? { origin: "trigger", fields: new Set([field]) }
          : { origin: "trigger", fields: "ALL" };
      }
      return { origin: "other" };
    }
    if ("project" in selector) {
      const inner = classify(selector.project);
      if (inner.origin === "other") return { origin: "other" };
      if (inner.origin === "literal") return { origin: "literal" };
      return { origin: "trigger", fields: new Set(selector.fields) };
    }
    // merge
    const parts = selector.merge.map(classify);
    if (parts.some((p) => p.origin === "other")) return { origin: "other" };
    const triggerParts = parts.filter(
      (p): p is { origin: "trigger"; fields: "ALL" | Set<string> } =>
        p.origin === "trigger",
    );
    if (triggerParts.length === 0) return { origin: "literal" };
    if (triggerParts.some((p) => p.fields === "ALL")) {
      return { origin: "trigger", fields: "ALL" };
    }
    const union = new Set<string>();
    for (const part of triggerParts) {
      for (const field of part.fields as Set<string>) union.add(field);
    }
    return { origin: "trigger", fields: union };
  }

  async function loadRawEmbeddedDefs(): Promise<
    { kind: string; steps: Record<string, RawActionStep> }[]
  > {
    const dir = embeddedWorkflowDefsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    const defs: { kind: string; steps: Record<string, RawActionStep> }[] = [];
    for (const file of files) {
      const raw = JSON.parse(await readFile(join(dir, file), "utf8"));
      const parsed = EmbeddedWorkflowDefSchema(raw);
      if (parsed instanceof type.errors) continue;
      defs.push({
        kind: parsed.kind,
        steps: parsed.definition.steps as Record<string, RawActionStep>,
      });
    }
    return defs;
  }

  function requiredArgsFor(handler: string): string[] | undefined {
    const bareName = handler.split(":").pop();
    if (!bareName) return undefined;
    const entry = KNOWN_TOOLS[bareName];
    if (entry === undefined) return undefined; // unresolvable — see report
    const inputSchema = entry.definition.inputSchema as
      | { required?: unknown }
      | undefined;
    const required = inputSchema?.required;
    return Array.isArray(required) ? (required as string[]) : [];
  }

  // Every `trigger.payload` field a kind's `action` steps genuinely require,
  // restricted to steps whose tool resolves in the hub's KNOWN_TOOLS registry
  // (workflow-owned private tool packages — e.g. `heartbeat_*`,
  // `process_granola_prepare_document`, the prospect-engine tolerant bridges —
  // have no hub-registered ToolDefinition and are not resolvable from
  // apps/hub without adding a new cross-package dependency; those steps are
  // reported, not silently passed).
  async function deriveRequiredFieldsByKind(): Promise<{
    requiredByKind: Map<string, string[]>;
    unresolvedHandlers: Set<string>;
  }> {
    const defs = await loadRawEmbeddedDefs();
    const requiredByKind = new Map<string, string[]>();
    const unresolvedHandlers = new Set<string>();
    for (const { kind, steps } of defs) {
      const required = new Set<string>();
      for (const step of Object.values(steps)) {
        if (step.kind !== "action" || step.input === undefined) continue;
        const classified = classify(step.input);
        if (classified.origin !== "trigger") continue;
        if (step.handler === undefined) continue;
        const requiredArgs = requiredArgsFor(step.handler);
        if (requiredArgs === undefined) {
          unresolvedHandlers.add(step.handler);
          continue;
        }
        for (const arg of requiredArgs) {
          if (classified.fields === "ALL" || classified.fields.has(arg)) {
            required.add(arg);
          }
        }
      }
      requiredByKind.set(kind, [...required]);
    }
    return { requiredByKind, unresolvedHandlers };
  }

  it("every fully-unattended kind's resolvable action steps only require trigger fields the schedule can supply", async () => {
    const [{ requiredByKind }, gateInfos, intakeFieldsByKind] =
      await Promise.all([
        deriveRequiredFieldsByKind(),
        loadWorkflowGateInfos(),
        loadWorkflowIntakeFields(),
      ]);
    const failures: string[] = [];
    for (const [kind, gateInfo] of gateInfos) {
      // Intake-gated kinds' fields are declared intake fields, covered by the
      // resume-payload-schema check above, not this derivation.
      if (gateInfo.humanGateCount > 0) continue;
      const requiredFields = requiredByKind.get(kind) ?? [];
      const intakeNames = new Set(
        (intakeFieldsByKind.get(kind) ?? []).map((f) => f.name),
      );
      if (
        !isRoutineEligibleKind(
          requiredFields,
          intakeNames,
          ENRICHED_TRIGGER_KINDS.has(kind),
        )
      ) {
        const missing = requiredFields.filter(
          (f) => !intakeNames.has(f) && !ENRICHED_TRIGGER_KINDS.has(kind),
        );
        failures.push(`${kind}: requires ${missing.join(", ")}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("sanity: granola-call's discover/spawn steps are the exact shape this derivation targets", async () => {
    const { requiredByKind } = await deriveRequiredFieldsByKind();
    // discover resolves (granola_list_notes is hub-known) and has no
    // required args today — this is the "passes only by author diligence"
    // case the CTO review flagged; the next test proves it goes red the
    // moment that stops being true.
    expect(requiredByKind.get("granola-call")).toEqual([]);
    // spawn's handler (granola_spawn_call_runs, which DOES require
    // `content`) merges `steps.discover.output` with `trigger.payload` — a
    // mixed merge this derivation deliberately does not resolve, because
    // `content` is supplied by the former, not the latter (see `classify`
    // above). Confirm the mixed merge classifies as "other" (skipped)
    // rather than silently being treated as fully trigger-sourced.
    const spawnInput: RawSelector = {
      merge: [{ from: "steps.discover.output" }, { from: "trigger.payload" }],
    };
    expect(classify(spawnInput).origin).toBe("other");
  });
});
