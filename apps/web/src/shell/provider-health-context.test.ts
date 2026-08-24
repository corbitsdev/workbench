import { describe, expect, test } from "bun:test";

import {
  deriveProviderHealthBanner,
  deriveProviderHealthChrome,
  nextProviderHealthPollStatus,
} from "./provider-health-context";

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
    expect(
      deriveProviderHealthBanner(providers, {}, 0)?.zeroWorkingProviders,
    ).toBe(true);
    expect(
      deriveProviderHealthBanner(providers, {}, 1)?.zeroWorkingProviders,
    ).toBe(false);
  });

  test("an unknown connected count never claims zero working providers", () => {
    const providers = {
      anthropic: { ...RECORD, at: "2026-08-15T00:00:00.000Z" },
    };
    expect(
      deriveProviderHealthBanner(providers, {}, undefined)
        ?.zeroWorkingProviders,
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
    expect(deriveProviderHealthBanner(providers, {}, 2)?.provider).toBe(
      "openai",
    );
  });
});

describe("nextProviderHealthPollStatus (CL-6834)", () => {
  test("a successful poll always lands on ready", () => {
    expect(nextProviderHealthPollStatus("unknown", "ok")).toBe("ready");
    expect(nextProviderHealthPollStatus("error", "ok")).toBe("ready");
    expect(nextProviderHealthPollStatus("ready", "ok")).toBe("ready");
  });

  test("first-load failure (unknown → fail) becomes error, not ready", () => {
    expect(nextProviderHealthPollStatus("unknown", "fail")).toBe("error");
  });

  test("a failed poll after an error stays error until a success", () => {
    expect(nextProviderHealthPollStatus("error", "fail")).toBe("error");
  });

  test("a failed poll after ready keeps ready so last-known state stays on screen", () => {
    expect(nextProviderHealthPollStatus("ready", "fail")).toBe("ready");
  });
});

describe("deriveProviderHealthChrome (CL-6834)", () => {
  const unhealthyBanner = {
    provider: "anthropic",
    category: "credential_failure" as const,
    zeroWorkingProviders: false,
  };

  test("unknown status is never healthy — empty providers are not 'all clear'", () => {
    expect(deriveProviderHealthChrome("unknown", null)).toEqual({
      kind: "unknown",
    });
    expect(deriveProviderHealthChrome("unknown", unhealthyBanner)).toEqual({
      kind: "unknown",
    });
  });

  test("error status is never healthy — first-load poll failure is not 'all clear'", () => {
    expect(deriveProviderHealthChrome("error", null)).toEqual({
      kind: "error",
    });
  });

  test("ready with no banner is healthy", () => {
    expect(deriveProviderHealthChrome("ready", null)).toEqual({
      kind: "healthy",
    });
  });

  test("ready with an undismissed incident is unhealthy", () => {
    expect(deriveProviderHealthChrome("ready", unhealthyBanner)).toEqual({
      kind: "unhealthy",
      banner: unhealthyBanner,
    });
  });
});
