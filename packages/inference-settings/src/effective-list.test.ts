import { describe, expect, test } from "bun:test";

import type { ModelInfo, ModelOfferingResponse } from "@intx/types";

import {
  buildEffectiveInferenceRows,
  computeReorderPatches,
  providerDisplayName,
  restrictedOfferings,
  rowsByModel,
  type EffectiveInferenceRow,
} from "./effective-list";

describe("providerDisplayName", () => {
  test("resolves a known provider slug to its own display name", () => {
    expect(providerDisplayName("ollama")).toBe("Ollama (local)");
    expect(providerDisplayName("opencode-zen")).toBe("Opencode Zen");
  });

  test("falls back to the raw slug for an unrecognized provider", () => {
    expect(providerDisplayName("some-custom-provider")).toBe(
      "some-custom-provider",
    );
  });
});

function row(
  offeringId: string,
  priority: number,
  provenance: EffectiveInferenceRow["provenance"] = "set-here",
): EffectiveInferenceRow {
  return {
    offeringId,
    modelId: "model-1",
    canonicalName: "claude-sonnet-5",
    modelDisplayName: null,
    providerId: `provider-${offeringId}`,
    providerName: offeringId,
    plugin: "anthropic",
    priority,
    provenance,
  };
}

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "model-1",
    canonicalName: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    offerings: [
      {
        offeringId: "offering-a",
        providerId: "provider-a",
        providerName: "anthropic",
        plugin: "anthropic",
        priority: 0,
        deploymentTags: [],
        capabilities: [],
        pricing: [],
      },
      {
        offeringId: "offering-b",
        providerId: "provider-b",
        providerName: "opencode-zen",
        plugin: "openai-compatible",
        priority: 1,
        deploymentTags: [],
        capabilities: [],
        pricing: [],
      },
    ],
    ...overrides,
  };
}

describe("buildEffectiveInferenceRows", () => {
  test("marks an owned offering id set-here and everything else inherited", () => {
    const rows = buildEffectiveInferenceRows(
      [model()],
      new Set(["offering-b"]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.offeringId).toBe("offering-a");
    expect(rows[0]?.provenance).toBe("inherited");
    expect(rows[1]?.offeringId).toBe("offering-b");
    expect(rows[1]?.provenance).toBe("set-here");
  });

  test("preserves each model's resolution-priority order across models", () => {
    const rows = buildEffectiveInferenceRows(
      [
        model(),
        model({
          id: "model-2",
          canonicalName: "gpt-4o-mini",
          displayName: "GPT-4o mini",
          offerings: [
            {
              offeringId: "offering-c",
              providerId: "provider-c",
              providerName: "openai",
              plugin: "openai",
              priority: 0,
              deploymentTags: [],
              capabilities: [],
              pricing: [],
            },
          ],
        }),
      ],
      new Set(),
    );
    expect(rows.map((row) => row.offeringId)).toEqual([
      "offering-a",
      "offering-b",
      "offering-c",
    ]);
  });

  test("an empty catalog yields no rows", () => {
    expect(buildEffectiveInferenceRows([], new Set())).toEqual([]);
  });
});

describe("rowsByModel", () => {
  test("groups rows under their model id, keeping row order", () => {
    const rows = buildEffectiveInferenceRows([model()], new Set());
    const grouped = rowsByModel(rows);
    expect(grouped.size).toBe(1);
    expect(grouped.get("model-1")?.map((row) => row.offeringId)).toEqual([
      "offering-a",
      "offering-b",
    ]);
  });
});

function expectPatches(
  patches:
    | readonly [
        { readonly offeringId: string; readonly priority: number },
        { readonly offeringId: string; readonly priority: number },
      ]
    | null,
): readonly [
  { readonly offeringId: string; readonly priority: number },
  { readonly offeringId: string; readonly priority: number },
] {
  if (patches === null) throw new Error("expected a patch pair, got null");
  return patches;
}

describe("computeReorderPatches", () => {
  test("swaps two distinctly-prioritized adjacent rows", () => {
    const rows = buildEffectiveInferenceRows(
      [model()],
      new Set(["offering-a", "offering-b"]),
    );
    const [earlier, later] = expectPatches(
      computeReorderPatches(rows, 1, "up"),
    );
    expect(earlier.offeringId).toBe("offering-b");
    expect(later.offeringId).toBe("offering-a");
    expect(earlier.priority).toBeLessThan(later.priority);
  });

  // Regression for the reorder-tie no-op: every seed-created or
  // priority-omitted offering defaults to priority 0, so two "set-here"
  // rows tied at 0 must still swap into a distinct, correctly ordered
  // pair — a plain value-swap (0, 0) would leave both unchanged.
  test("swapping two equal-priority rows still produces distinct, correctly ordered priorities", () => {
    const rows: EffectiveInferenceRow[] = [row("a", 0), row("b", 0)];
    const [earlier, later] = expectPatches(
      computeReorderPatches(rows, 1, "up"),
    );
    expect(earlier.offeringId).toBe("b");
    expect(later.offeringId).toBe("a");
    expect(earlier.priority).not.toBe(later.priority);
    expect(earlier.priority).toBeLessThan(later.priority);
  });

  test("keeps the swapped pair within its fixed neighbors' priorities", () => {
    const rows: EffectiveInferenceRow[] = [
      row("fixed-low", 0, "inherited"),
      row("a", 0),
      row("b", 0),
      row("fixed-high", 1, "inherited"),
    ];
    const [earlier, later] = expectPatches(
      computeReorderPatches(rows, 2, "up"),
    );
    expect(earlier.priority).toBeGreaterThanOrEqual(0);
    expect(later.priority).toBeLessThanOrEqual(1);
    expect(earlier.priority).toBeLessThan(later.priority);
  });

  test("returns null when the move would run off the edge of the list", () => {
    const rows = buildEffectiveInferenceRows(
      [model()],
      new Set(["offering-a", "offering-b"]),
    );
    expect(computeReorderPatches(rows, 0, "up")).toBeNull();
  });

  test("returns null when the neighbor is inherited (not shadowed yet)", () => {
    const rows = buildEffectiveInferenceRows(
      [model()],
      new Set(["offering-b"]),
    );
    expect(computeReorderPatches(rows, 1, "up")).toBeNull();
  });
});

// UI truth: the order a member sees must be the order a launch would try.
// `resolveModelSources`'s `byPriority` (vendor/intx/db/src/model-source-
// resolution.ts) sorts priority ascending, id tiebreak only on an exact
// priority tie. `buildEffectiveInferenceRows` never re-sorts — it trusts
// the resolved catalog's own order — so this only genuinely holds once
// `computeReorderPatches` has made every row's priority distinct; while
// two rows are still tied (never reordered), the discovery route's own
// tiebreak (provider name, not id — vendor/intx/hub-api/src/routes/
// models.ts's `composeDiscoveredModels`) can disagree with launch order.
// This guards the case the fix actually delivers: distinct priorities
// sort identically no matter which tiebreak a comparator uses, since the
// tiebreak never engages.
describe("resolution-order truth", () => {
  test("with distinct priorities, row order matches priority-ascending regardless of tiebreak", () => {
    const rows: EffectiveInferenceRow[] = [
      row("c", 5),
      row("a", 1),
      row("b", 3),
    ];
    const byPriorityIdTiebreak = [...rows].sort(
      (x, y) =>
        x.priority - y.priority || (x.offeringId < y.offeringId ? -1 : 1),
    );
    const byPriorityNameTiebreak = [...rows].sort(
      (x, y) =>
        x.priority - y.priority || x.providerName.localeCompare(y.providerName),
    );
    expect(byPriorityIdTiebreak.map((r) => r.offeringId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(byPriorityNameTiebreak.map((r) => r.offeringId)).toEqual(
      byPriorityIdTiebreak.map((r) => r.offeringId),
    );
  });
});

describe("restrictedOfferings", () => {
  function offering(
    overrides: Partial<typeof ModelOfferingResponse.infer> = {},
  ): typeof ModelOfferingResponse.infer {
    return {
      id: "offering-a",
      tenantId: "tenant-1",
      modelId: "model-1",
      providerId: "provider-a",
      priority: 0,
      deploymentTags: [],
      capabilities: [],
      quirks: null,
      disabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  test("keeps only this tenant's disabled offerings", () => {
    const rows = restrictedOfferings([
      offering({ id: "a", disabled: false }),
      offering({ id: "b", disabled: true }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["b"]);
  });

  test("an empty offering list yields no restricted rows", () => {
    expect(restrictedOfferings([])).toEqual([]);
  });
});
