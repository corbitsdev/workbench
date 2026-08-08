import { describe, expect, test } from "bun:test";

import { searchEntities } from "../src/entity-search";

describe("searchEntities", () => {
  const channels = [
    { id: "chan-1", name: "Launch Planning" },
    { id: "chan-2", name: "Support Triage" },
  ];
  const runs = [
    { id: "run-1", name: "Nightly Digest" },
    { id: "run-2", name: "Launch Retro" },
  ];

  test("matches by title across every category and never surfaces a raw id", () => {
    const page = searchEntities({ query: "launch", channels, runs, pageSize: 10, offset: 0 });
    const titles = page.results.map((result) => result.title);
    expect(titles).toEqual(["Launch Planning", "Launch Retro"]);
    expect(page.results.every((result) => !result.title.startsWith("chan-") && !result.title.startsWith("run-"))).toBe(
      true,
    );
  });

  test("an empty query returns no results — the palette shows its own empty state", () => {
    const page = searchEntities({ query: "", channels, runs, pageSize: 10, offset: 0 });
    expect(page.results).toEqual([]);
  });

  test("paginates with a page size and reports whether more results remain", () => {
    const first = searchEntities({ query: "a", channels, runs, pageSize: 1, offset: 0 });
    expect(first.results).toHaveLength(1);
    expect(first.hasMore).toBe(true);

    const second = searchEntities({ query: "a", channels, runs, pageSize: 1, offset: 1 });
    expect(second.results).toHaveLength(1);
  });

  test("categorizes channel and routine results distinctly", () => {
    const page = searchEntities({ query: "launch", channels, runs, pageSize: 10, offset: 0 });
    const categories = page.results.map((result) => result.category);
    expect(categories).toEqual(["channels", "routines"]);
  });
});
