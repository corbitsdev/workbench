import { describe, expect, test } from "bun:test";

import { inferenceSourcesDigest, type ResolvedLaunchSources } from "./launch";

const anthropic = {
  id: "off_anthropic",
  provider: "anthropic",
  baseURL: "https://api.anthropic.com",
  credentialId: "cred_anthropic",
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
          credentialId: anthropic.credentialId,
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

  // At the 692c3106 pin an `InferenceSource` names its credential by id
  // instead of carrying the decrypted secret, so the digest tracks WHICH
  // credential a chain resolved to, not the bytes behind it. Re-pointing a
  // source at a different credential still changes the digest; rotating the
  // secret in place no longer does, because the secret now travels in the
  // deploy's credential-material cell rather than in the source.
  test("changes when a source is re-pointed at a different credential", () => {
    const repointed: ResolvedLaunchSources = {
      ...resolved,
      sources: [{ ...anthropic, credentialId: "cred_anthropic_rotated" }],
    };
    const digest = inferenceSourcesDigest(repointed);
    expect(digest).not.toBe(inferenceSourcesDigest(resolved));
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
