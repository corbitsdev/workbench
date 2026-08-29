import { describe, expect, test } from "bun:test";

import { inferenceSourcesDigest, type ResolvedLaunchSources } from "./launch";

const anthropic = {
  id: "off_anthropic",
  provider: "anthropic",
  baseURL: "https://api.anthropic.com",
  apiKey: "sk-ant-old",
  model: "claude-sonnet-5",
};

const resolved: ResolvedLaunchSources = {
  sources: [anthropic],
  defaultSource: "off_anthropic",
};

describe("inferenceSourcesDigest", () => {
  test("is stable across key insertion order", () => {
    const reordered: ResolvedLaunchSources = {
      defaultSource: "off_anthropic",
      sources: [
        {
          model: anthropic.model,
          apiKey: anthropic.apiKey,
          baseURL: anthropic.baseURL,
          provider: anthropic.provider,
          id: anthropic.id,
        },
      ],
    };
    expect(inferenceSourcesDigest(reordered)).toBe(
      inferenceSourcesDigest(resolved),
    );
  });

  test("changes when the secret rotates, without carrying the secret", () => {
    const rotated: ResolvedLaunchSources = {
      ...resolved,
      sources: [{ ...anthropic, apiKey: "sk-ant-new" }],
    };
    const digest = inferenceSourcesDigest(rotated);
    expect(digest).not.toBe(inferenceSourcesDigest(resolved));
    expect(digest).not.toContain("sk-ant");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when the default source moves", () => {
    const openai = { ...anthropic, id: "off_openai", provider: "openai" };
    const chain: ResolvedLaunchSources = {
      sources: [anthropic, openai],
      defaultSource: "off_anthropic",
    };
    expect(
      inferenceSourcesDigest({ ...chain, defaultSource: "off_openai" }),
    ).not.toBe(inferenceSourcesDigest(chain));
  });
});
