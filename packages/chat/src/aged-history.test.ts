/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { MYRA_AGED_HISTORY_MS, isMyraHistoryAged } from "./aged-history";

describe("aged-history", () => {
  const now = Date.parse("2026-07-14T12:00:00.000Z");

  it("treats turns within 24h as fresh", () => {
    const createdAt = new Date(
      now - MYRA_AGED_HISTORY_MS + 60_000,
    ).toISOString();
    expect(isMyraHistoryAged(createdAt, now)).toBe(false);
  });

  it("treats turns at or beyond 24h as aged", () => {
    const atThreshold = new Date(now - MYRA_AGED_HISTORY_MS).toISOString();
    expect(isMyraHistoryAged(atThreshold, now)).toBe(true);
    const older = new Date(now - MYRA_AGED_HISTORY_MS - 1).toISOString();
    expect(isMyraHistoryAged(older, now)).toBe(true);
  });

  it("returns false for invalid timestamps", () => {
    expect(isMyraHistoryAged("not-a-date", now)).toBe(false);
  });
});
