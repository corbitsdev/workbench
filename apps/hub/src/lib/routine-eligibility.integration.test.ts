import { describe, expect, it } from "bun:test";
import { isRoutineEligibleKind } from "@workbench/shared";
import {
  loadWorkflowCatalogKinds,
  loadWorkflowEntryTriggerFields,
  loadWorkflowGateInfos,
  loadWorkflowIntakeFields,
} from "./workflow-catalog";
import { isKindStructurallyAttachable } from "./workflow-gate-info";
import { ENRICHED_TRIGGER_KINDS } from "../workflow-executor/trigger-payload-enrichment-registry";
import { requiredIntakeSchemaKeys } from "../workflow-executor/resume-payload-registry";

// Real end-to-end exercise of the derived routine-eligibility rule (CL-4204)
// against the actual committed embedded catalog (apps/hub/generated/workflow-defs)
// and the actual trigger-payload-enrichment registry — no mocks. This is the
// seam the unit tests (workflow-gate-info.test.ts, routine-eligible.test.ts)
// cannot see: whether the real defs' entry steps actually have their required
// trigger fields covered by the real declared intake fields or the real
// registered enrichers.
async function attachableKinds(): Promise<Set<string>> {
  const [gateInfos, entryTriggerFieldsByKind, intakeFieldsByKind] =
    await Promise.all([
      loadWorkflowGateInfos(),
      loadWorkflowEntryTriggerFields(),
      loadWorkflowIntakeFields(),
    ]);
  const kinds = new Set<string>();
  for (const [kind, gateInfo] of gateInfos) {
    if (!isKindStructurallyAttachable(gateInfo, kind)) continue;
    const intakeNames = new Set(
      (intakeFieldsByKind.get(kind) ?? []).map((f) => f.name),
    );
    if (
      isRoutineEligibleKind(
        entryTriggerFieldsByKind.get(kind) ?? [],
        intakeNames,
        ENRICHED_TRIGGER_KINDS.has(kind),
      )
    ) {
      kinds.add(kind);
    }
  }
  return kinds;
}

describe("derived routine eligibility against the real embedded catalog", () => {
  // granola-call used to be excluded here: its entry step carried a
  // `workbench.argMap` tag, and the eligibility derivation read every `from`
  // in that tag as a required trigger field — including ones the producer had
  // marked `optional: true`. Migrating the workflow to the native `action`
  // primitive removed the tag entirely, so the derivation now correctly finds
  // no required trigger fields and the kind is schedulable, which is what its
  // author intended (every one of its tool args is optional).
  it("includes granola-call: its native action entry step requires no trigger fields", async () => {
    const kinds = await attachableKinds();
    expect(kinds.has("granola-call")).toBe(true);
  });

  it("includes heartbeat and prospect-engine via their registered trigger-payload enrichers", async () => {
    const kinds = await attachableKinds();
    expect(kinds.has("heartbeat")).toBe(true);
    expect(kinds.has("prospect-engine")).toBe(true);
  });

  it("includes intake-declared research/watch kinds", async () => {
    const kinds = await attachableKinds();
    expect(kinds.has("last30days-research")).toBe(true);
    expect(kinds.has("exa-topic-watch")).toBe(true);
    expect(kinds.has("firecrawl-url-watch")).toBe(true);
    expect(kinds.has("github-topic-watch")).toBe(true);
    expect(kinds.has("reddit-opportunity-watch")).toBe(true);
  });

  it("still excludes a structurally-unattachable multi-gate kind (unaffected by this derivation)", async () => {
    const kinds = await attachableKinds();
    expect(kinds.has("attio-task-agent")).toBe(false);
  });
});

// CL-4538: gtm-scripts-briefs declared its `intake` fields only in the dock's
// private `blocks.ts` builder, never on the workflow definition — the schedule/
// attach form (which reads a definition's exported `INTAKE_FIELDS`) rendered no
// inputs at all, then the `/resume` boundary rejected the hollow payload for
// missing `topic`/`days`. This checks EVERY real committed workflow kind
// (deliberately not narrowed to today's schedule-attachable subset — a kind
// that is not attachable today is still the same authoring defect once
// attachability gating changes), so a future workflow that registers an
// `intake` resume-payload schema without declaring matching intake fields
// fails here instead of shipping the same silent-empty-form bug.
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
