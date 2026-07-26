import { describe, expect, it } from "bun:test";
import { isRoutineEligibleKind } from "@workbench/shared";
import {
  loadWorkflowCatalogKinds,
  loadWorkflowEntryTriggerFields,
  loadWorkflowIntakeFields,
} from "./workflow-catalog";
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
});
