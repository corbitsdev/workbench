import { describe, expect, test } from "bun:test";

import type { ModelInfo, ModelOfferingResponse } from "@intx/types";

import {
  buildEffectiveInferenceRows,
  restrictedOfferings,
  rowsByModel,
  swapPriority,
} from "./effective-list";

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

describe("swapPriority", () => {
  test("exchanges the two rows' priorities without touching anything else", () => {
    const rows = buildEffectiveInferenceRows([model()], new Set());
    const moved = rows[1];
    const neighbor = rows[0];
    if (moved === undefined || neighbor === undefined) {
      throw new Error("expected two rows");
    }
    const [movedPatch, neighborPatch] = swapPriority(moved, neighbor);
    expect(movedPatch).toEqual({ offeringId: "offering-b", priority: 0 });
    expect(neighborPatch).toEqual({ offeringId: "offering-a", priority: 1 });
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
