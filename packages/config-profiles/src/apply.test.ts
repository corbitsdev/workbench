import { describe, expect, test } from "bun:test";

import type { EffectiveInferenceRow } from "@corbits/inference-settings/effective-list";

import { planApply } from "./apply";

function row(
  overrides: Partial<EffectiveInferenceRow> & {
    offeringId: string;
    canonicalName: string;
    providerName: string;
  },
): EffectiveInferenceRow {
  return {
    offeringId: overrides.offeringId,
    modelId: overrides.modelId ?? `mdl_${overrides.canonicalName}`,
    canonicalName: overrides.canonicalName,
    modelDisplayName: overrides.modelDisplayName ?? null,
    providerId: overrides.providerId ?? `prv_${overrides.providerName}`,
    providerName: overrides.providerName,
    plugin: overrides.plugin ?? "openai",
    priority: overrides.priority ?? 0,
    provenance: overrides.provenance ?? "set-here",
  };
}

describe("planApply", () => {
  test("a set-here match becomes a reordered PATCH at the entry's own index", () => {
    const rows = [
      row({
        offeringId: "ofr_1",
        canonicalName: "gpt-5",
        providerName: "OpenAI",
      }),
    ];
    const plan = planApply([{ provider: "OpenAI", model: "gpt-5" }], rows);
    expect(plan).toEqual([
      {
        provider: "OpenAI",
        model: "gpt-5",
        action: "reordered",
        offeringId: "ofr_1",
        priority: 0,
        disabled: false,
      },
    ]);
  });

  test("preserves the profile's own order as the new priority, not the source priority", () => {
    const rows = [
      row({
        offeringId: "ofr_1",
        canonicalName: "gpt-5",
        providerName: "OpenAI",
        priority: 5,
      }),
      row({
        offeringId: "ofr_2",
        canonicalName: "claude",
        providerName: "Anthropic",
        priority: 1,
      }),
    ];
    // Profile lists Anthropic first even though it currently resolves
    // second — the profile's order wins.
    const plan = planApply(
      [
        { provider: "Anthropic", model: "claude" },
        { provider: "OpenAI", model: "gpt-5" },
      ],
      rows,
    );
    expect(
      plan.map((step) => (step.action === "reordered" ? step.priority : -1)),
    ).toEqual([0, 1]);
    expect(
      plan.map((step) => (step.action === "reordered" ? step.offeringId : "")),
    ).toEqual(["ofr_2", "ofr_1"]);
  });

  test("an entry's own disabled flag carries into the plan; omitted defaults to false", () => {
    const rows = [
      row({
        offeringId: "ofr_1",
        canonicalName: "gpt-5",
        providerName: "OpenAI",
      }),
    ];
    const plan = planApply(
      [{ provider: "OpenAI", model: "gpt-5", disabled: true }],
      rows,
    );
    expect(plan[0]).toMatchObject({ action: "reordered", disabled: true });
  });

  test("an inherited-only match is reported skipped-inherited, never PATCHed", () => {
    const rows = [
      row({
        offeringId: "ofr_1",
        canonicalName: "gpt-5",
        providerName: "OpenAI",
        provenance: "inherited",
      }),
    ];
    const plan = planApply([{ provider: "OpenAI", model: "gpt-5" }], rows);
    expect(plan).toEqual([
      { provider: "OpenAI", model: "gpt-5", action: "skipped-inherited" },
    ]);
  });

  test("no match at all is reported skipped-unavailable", () => {
    const plan = planApply([{ provider: "Cohere", model: "command" }], []);
    expect(plan).toEqual([
      { provider: "Cohere", model: "command", action: "skipped-unavailable" },
    ]);
  });

  test("an empty profile plans no steps", () => {
    expect(planApply([], [])).toEqual([]);
  });
});
