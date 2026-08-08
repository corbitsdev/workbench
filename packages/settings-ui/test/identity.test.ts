// `principalLabel`'s one job: never hand back a raw refId/address as the
// label a person reads, while leaving an already-humane display name alone.

import { describe, expect, test } from "bun:test";

import { principalLabel } from "../src/identity";

describe("principalLabel", () => {
  test("passes through an already-humane display name unchanged", () => {
    const result = principalLabel("Ada Lovelace");
    expect(result.label).toBe("Ada Lovelace");
    expect(result.raw).toBeNull();
  });

  test("derives a humane label from a raw agent refId and keeps the raw value", () => {
    const result = principalLabel("agt_research-assistant");
    expect(result.label).toBe("Research Assistant");
    expect(result.raw).toBe("agt_research-assistant");
  });

  test("derives a humane label from an address-shaped refId", () => {
    const result = principalLabel("agent://tenant-1/billing-bot@hub.local");
    expect(result.raw).toBe("agent://tenant-1/billing-bot@hub.local");
    expect(result.label).not.toContain("://");
    expect(result.label.length).toBeGreaterThan(0);
  });

  test("falls back to a plain label when nothing recognizable survives", () => {
    const result = principalLabel("agt_------");
    expect(result.label).toBe("Unnamed agent");
  });
});
