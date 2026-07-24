import { describe, expect, it } from "bun:test";
import { isRoutineEligibleKind } from "@workbench/shared";
import {
  loadWorkflowEntryTriggerFields,
  loadWorkflowGateInfos,
  loadWorkflowIntakeFields,
} from "./workflow-catalog";
import { isKindStructurallyAttachable } from "./workflow-gate-info";
import { ENRICHED_TRIGGER_KINDS } from "../workflow-executor/trigger-payload-enrichment-registry";

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
  it("excludes granola-call: it reads a required noteId off the trigger payload with no intake field and no registered enricher", async () => {
    const kinds = await attachableKinds();
    expect(kinds.has("granola-call")).toBe(false);
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
