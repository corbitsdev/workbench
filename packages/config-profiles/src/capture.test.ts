import { describe, expect, test } from "bun:test";

import type { ModelInfo } from "@corbits/inference-settings/api";

import { buildProfileEntriesFromWorkbench } from "./capture";

const models: readonly ModelInfo[] = [
  {
    id: "mdl_1",
    canonicalName: "gpt-5",
    offerings: [
      {
        offeringId: "ofr_1",
        providerId: "prv_1",
        providerName: "OpenAI",
        plugin: "openai",
        priority: 0,
        deploymentTags: [],
        capabilities: [],
        pricing: [],
      },
      {
        offeringId: "ofr_2",
        providerId: "prv_2",
        providerName: "Azure",
        plugin: "openai",
        priority: 1,
        deploymentTags: [],
        capabilities: [],
        pricing: [],
      },
    ],
  },
  {
    id: "mdl_2",
    canonicalName: "claude",
    offerings: [
      {
        offeringId: "ofr_3",
        providerId: "prv_3",
        providerName: "Anthropic",
        plugin: "anthropic",
        priority: 0,
        deploymentTags: [],
        capabilities: [],
        pricing: [],
      },
    ],
  },
];

describe("buildProfileEntriesFromWorkbench", () => {
  test("flattens every model's offerings, in the resolved catalog's own order", () => {
    const entries = buildProfileEntriesFromWorkbench(models, new Set());
    expect(entries).toEqual([
      { provider: "OpenAI", model: "gpt-5" },
      { provider: "Azure", model: "gpt-5" },
      { provider: "Anthropic", model: "claude" },
    ]);
  });

  test("captured entries never carry disabled: true, regardless of provenance", () => {
    const entries = buildProfileEntriesFromWorkbench(
      models,
      new Set(["ofr_1"]),
    );
    expect(entries.every((entry) => entry.disabled === undefined)).toBe(true);
  });

  test("an empty catalog captures no entries", () => {
    expect(buildProfileEntriesFromWorkbench([], new Set())).toEqual([]);
  });
});
