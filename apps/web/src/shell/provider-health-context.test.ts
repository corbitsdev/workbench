import { describe, expect, test } from "bun:test";

import { deriveProviderHealthBanner } from "./provider-health-context";

const RECORD = {
  status: "needs_attention" as const,
  category: "credential_failure" as const,
};

describe("deriveProviderHealthBanner", () => {
  test("returns null when nothing is unhealthy", () => {
    expect(deriveProviderHealthBanner({}, {}, undefined)).toBeNull();
  });

  test("surfaces an unhealthy provider's own category", () => {
    const banner = deriveProviderHealthBanner(
      { anthropic: { ...RECORD, at: "2026-08-15T00:00:00.000Z" } },
      {},
      2,
    );
    expect(banner).toEqual({
      provider: "anthropic",
      category: "credential_failure",
      zeroWorkingProviders: false,
    });
  });

  test("zeroWorkingProviders is true only when the connected count is exactly 0", () => {
    const providers = {
      anthropic: { ...RECORD, at: "2026-08-15T00:00:00.000Z" },
    };
    expect(deriveProviderHealthBanner(providers, {}, 0)?.zeroWorkingProviders).toBe(
      true,
    );
    expect(deriveProviderHealthBanner(providers, {}, 1)?.zeroWorkingProviders).toBe(
      false,
    );
  });

  test("an unknown connected count never claims zero working providers", () => {
    const providers = {
      anthropic: { ...RECORD, at: "2026-08-15T00:00:00.000Z" },
    };
    expect(
      deriveProviderHealthBanner(providers, {}, undefined)?.zeroWorkingProviders,
    ).toBe(false);
  });

  test("a dismissed incident (same `at`) is hidden", () => {
    const providers = {
      anthropic: { ...RECORD, at: "2026-08-15T00:00:00.000Z" },
    };
    const dismissed = { anthropic: "2026-08-15T00:00:00.000Z" };
    expect(deriveProviderHealthBanner(providers, dismissed, 1)).toBeNull();
  });

  test("a NEW incident (different `at`) for the same provider reappears after dismissal", () => {
    const providers = {
      anthropic: { ...RECORD, at: "2026-08-15T01:00:00.000Z" },
    };
    const dismissed = { anthropic: "2026-08-15T00:00:00.000Z" };
    expect(deriveProviderHealthBanner(providers, dismissed, 1)).not.toBeNull();
  });

  test("with more than one unhealthy provider, the most recently reported one wins", () => {
    const providers = {
      anthropic: {
        ...RECORD,
        category: "quota_exhausted" as const,
        at: "2026-08-15T00:00:00.000Z",
      },
      openai: { ...RECORD, at: "2026-08-15T01:00:00.000Z" },
    };
    expect(deriveProviderHealthBanner(providers, {}, 2)?.provider).toBe("openai");
  });
});
