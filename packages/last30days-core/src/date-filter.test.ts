import { describe, expect, test } from "bun:test";
import { dateFilter } from "./date-filter";

const NOW_ISO = "2026-06-11T12:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();

function isoMsAgo(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function isoDaysAgo(days: number): string {
  return isoMsAgo(days * 24 * 60 * 60 * 1000);
}

describe("dateFilter", () => {
  test("keeps items within the window", () => {
    const items = [
      { publishedAt: isoDaysAgo(1), id: "recent" },
      { publishedAt: isoDaysAgo(10), id: "mid" },
      { publishedAt: isoDaysAgo(29), id: "near-edge" },
    ];
    const result = dateFilter(items, { days: 30, nowIso: NOW_ISO });
    expect(result).toHaveLength(3);
  });

  test("drops items outside the window", () => {
    const items = [
      { publishedAt: isoDaysAgo(31), id: "old" },
      { publishedAt: isoDaysAgo(60), id: "very-old" },
    ];
    const result = dateFilter(items, { days: 30, nowIso: NOW_ISO });
    expect(result).toHaveLength(0);
  });

  test("item exactly at boundary is kept", () => {
    const cutoff = new Date(NOW_ISO);
    cutoff.setUTCDate(cutoff.getUTCDate() - 30);
    const items = [{ publishedAt: cutoff.toISOString(), id: "boundary" }];
    const result = dateFilter(items, { days: 30, nowIso: NOW_ISO });
    expect(result).toHaveLength(1);
  });

  test("item one second outside the boundary is dropped", () => {
    const items = [
      {
        publishedAt: isoMsAgo(30 * 24 * 60 * 60 * 1000 + 1000),
        id: "just-outside",
      },
    ];
    const result = dateFilter(items, { days: 30, nowIso: NOW_ISO });
    expect(result).toHaveLength(0);
  });

  test("empty array returns empty array", () => {
    expect(dateFilter([], { days: 30, nowIso: NOW_ISO })).toEqual([]);
  });

  test("zero-day window drops all items before nowIso", () => {
    const items = [
      { publishedAt: isoMsAgo(60_000), id: "one-minute-ago" },
      { publishedAt: isoDaysAgo(1), id: "yesterday" },
    ];
    const result = dateFilter(items, { days: 0, nowIso: NOW_ISO });
    expect(result).toHaveLength(0);
  });

  test("preserves item shape unchanged", () => {
    const items = [{ publishedAt: isoDaysAgo(1), id: "x", extra: "data" }];
    const result = dateFilter(items, { days: 30, nowIso: NOW_ISO });
    expect(result[0]).toEqual(items[0]);
  });
});
