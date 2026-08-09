import { describe, expect, test } from "bun:test";

import { searchEntities } from "../src/entity-search";

describe("searchEntities", () => {
  const sources = [
    {
      category: "channels",
      entities: [
        { id: "chan-1", name: "Launch Planning" },
        { id: "chan-2", name: "Support Triage" },
      ],
    },
    {
      category: "routines",
      entities: [
        { id: "rt-1", name: "Nightly Digest" },
        { id: "rt-2", name: "Launch Retro" },
      ],
    },
    {
      category: "agents",
      entities: [
        { id: "agent-1", name: "Launch Agent" },
        { id: "agent-2", name: "Research Helper" },
      ],
    },
  ];

  test("matches by title across every source and never surfaces a raw id", () => {
    const page = searchEntities({
      query: "launch",
      sources,
      pageSize: 10,
      offset: 0,
    });
    const titles = page.results.map((result) => result.title);
    expect(titles).toEqual(["Launch Planning", "Launch Retro", "Launch Agent"]);
    expect(
      page.results.every(
        (result) =>
          !result.title.startsWith("chan-") &&
          !result.title.startsWith("rt-") &&
          !result.title.startsWith("agent-"),
      ),
    ).toBe(true);
  });

  test("an empty query returns no results — the palette shows its own empty state", () => {
    const page = searchEntities({
      query: "",
      sources,
      pageSize: 10,
      offset: 0,
    });
    expect(page.results).toEqual([]);
  });

  test("paginates with a page size and reports whether more results remain", () => {
    const first = searchEntities({
      query: "a",
      sources,
      pageSize: 1,
      offset: 0,
    });
    expect(first.results).toHaveLength(1);
    expect(first.hasMore).toBe(true);

    const second = searchEntities({
      query: "a",
      sources,
      pageSize: 1,
      offset: 1,
    });
    expect(second.results).toHaveLength(1);
  });

  test("preserves source order and categorizes results by their source", () => {
    const page = searchEntities({
      query: "launch",
      sources,
      pageSize: 10,
      offset: 0,
    });
    const categories = page.results.map((result) => result.category);
    expect(categories).toEqual(["channels", "routines", "agents"]);
  });

  test("returns nothing for a source with no matching entities", () => {
    const page = searchEntities({
      query: "research",
      sources,
      pageSize: 10,
      offset: 0,
    });
    const titles = page.results.map((result) => result.title);
    expect(titles).toEqual(["Research Helper"]);
    expect(page.results[0]?.category).toBe("agents");
  });

  test("handles an empty sources list without error", () => {
    const page = searchEntities({
      query: "anything",
      sources: [],
      pageSize: 10,
      offset: 0,
    });
    expect(page.results).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});
