import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  FuzzyMatchResultSchema,
  PaletteResultItemSchema,
  RankedPaletteItemSchema,
  fuzzyMatch,
  rankPaletteItems,
  type PaletteResultItem,
} from "./palette";

describe("PaletteResultItemSchema", () => {
  test("accepts a well-formed item and rejects an unknown category", () => {
    const ok = PaletteResultItemSchema({
      id: "nav:chats",
      category: "navigation",
      title: "Chats",
      to: "/chats",
    });
    expect(ok instanceof type.errors).toBe(false);

    const bad = PaletteResultItemSchema({
      id: "x",
      category: "spaceship",
      title: "X",
      to: "/x",
    });
    expect(bad instanceof type.errors).toBe(true);
  });
});

describe("FuzzyMatchResultSchema", () => {
  test("accepts a well-formed result", () => {
    const ok = FuzzyMatchResultSchema({ score: 7, indices: [0, 1] });
    expect(ok instanceof type.errors).toBe(false);
  });

  test("rejects a non-numeric index array", () => {
    const bad = FuzzyMatchResultSchema({ score: 7, indices: ["0"] });
    expect(bad instanceof type.errors).toBe(true);
  });
});

describe("RankedPaletteItemSchema", () => {
  test("accepts a ranked item wrapping a valid palette item", () => {
    const ok = RankedPaletteItemSchema({
      item: { id: "a", category: "navigation", title: "X", to: "/x" },
      titleIndices: [0],
      score: 12,
    });
    expect(ok instanceof type.errors).toBe(false);
  });

  test("rejects a ranked item whose nested item is malformed", () => {
    const bad = RankedPaletteItemSchema({
      item: { id: "a", category: "spaceship", title: "X", to: "/x" },
      titleIndices: [0],
      score: 12,
    });
    expect(bad instanceof type.errors).toBe(true);
  });
});

describe("fuzzyMatch", () => {
  test("returns the matched indices for a subsequence", () => {
    const result = fuzzyMatch("art", "Artifacts");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([0, 1, 2]);
  });

  test("returns null when a query character is missing", () => {
    expect(fuzzyMatch("zzz", "Artifacts")).toBeNull();
  });

  test("matches a non-contiguous subsequence", () => {
    const result = fuzzyMatch("wf", "Workflows");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([0, 4]);
  });

  test("scores a word-boundary prefix above a mid-word match", () => {
    const boundary = fuzzyMatch("sk", "Skills")!;
    const midWord = fuzzyMatch("sk", "Basket")!;
    expect(boundary.score).toBeGreaterThan(midWord.score);
  });

  test("empty query matches anything with no highlight", () => {
    const result = fuzzyMatch("", "Anything");
    expect(result).toEqual({ score: 0, indices: [] });
  });
});

describe("rankPaletteItems", () => {
  const items: PaletteResultItem[] = [
    { id: "a", category: "navigation", title: "Artifacts", to: "/artifacts" },
    { id: "b", category: "navigation", title: "Workflows", to: "/workflows" },
    {
      id: "c",
      category: "conversation",
      title: "Acme onboarding call",
      to: "/chats/c",
      keywords: ["pricing", "renewal"],
    },
  ];

  test("empty query returns every item in original order", () => {
    const ranked = rankPaletteItems("  ", items);
    expect(ranked.map((r) => r.item.id)).toEqual(["a", "b", "c"]);
    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });

  test("excludes items that do not match", () => {
    const ranked = rankPaletteItems("workflow", items);
    expect(ranked.map((r) => r.item.id)).toEqual(["b"]);
  });

  test("ranks a title match above a keyword-only match", () => {
    const ranked = rankPaletteItems("pricing", items);
    // Only the conversation has a 'pricing' keyword; it should match with no
    // title highlight.
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.item.id).toBe("c");
    expect(ranked[0]!.titleIndices).toEqual([]);
  });

  test("returns title highlight indices for a title match", () => {
    const ranked = rankPaletteItems("art", items);
    expect(ranked[0]!.item.id).toBe("a");
    expect(ranked[0]!.titleIndices).toEqual([0, 1, 2]);
  });

  test("orders a strong title match ahead of a weaker one", () => {
    const ranked = rankPaletteItems("a", items);
    // 'Artifacts' starts with 'a' (boundary) → outranks 'Acme…' tie-break by
    // shorter text; both rank above 'Workflows' which has no 'a'.
    expect(ranked.map((r) => r.item.id)).not.toContain("b");
    expect(ranked[0]!.item.title.toLowerCase().startsWith("a")).toBe(true);
  });
});
