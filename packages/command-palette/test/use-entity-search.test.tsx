import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { useEntitySearch } from "../src/use-entity-search";
import type { UseEntitySearchResult } from "../src/use-entity-search";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CHANNELS = [
  { id: "chan-1", name: "Launch Planning" },
  { id: "chan-2", name: "Support Triage" },
];
const ROUTINES = [
  { id: "rt-1", name: "Nightly Digest" },
  { id: "rt-2", name: "Launch Retro" },
];
const AGENTS = [
  { id: "agent-1", name: "Launch Agent" },
  { id: "agent-2", name: "Research Helper" },
];

const SOURCES = [
  { category: "channels", fetch: () => Promise.resolve(CHANNELS) },
  { category: "routines", fetch: () => Promise.resolve(ROUTINES) },
  { category: "agents", fetch: () => Promise.resolve(AGENTS) },
];

function mount(initialQuery: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let latest: UseEntitySearchResult | undefined;
  let setQuery: (query: string) => void = () => {};

  function Host() {
    const [query, setState] = useState(initialQuery);
    setQuery = setState;
    latest = useEntitySearch({
      query,
      enabled: true,
      pageSize: 1,
      debounceMs: 5,
      sources: SOURCES,
    });
    return null;
  }

  act(() => {
    root.render(createElement(Host));
  });

  return {
    setQuery: (query: string) =>
      act(() => {
        setQuery(query);
      }),
    settle: () => act(() => sleep(30)),
    get: () => latest as UseEntitySearchResult,
    unmount: () => root.unmount(),
  };
}

describe("useEntitySearch", () => {
  test("an empty query fetches nothing and returns no results", async () => {
    const harness = mount("");
    await harness.settle();
    expect(harness.get().results).toEqual([]);
    expect(harness.get().loading).toBe(false);
    harness.unmount();
  });

  test("debounces the query before searching, then reports matches with the raw id never in the title", async () => {
    const harness = mount("");
    await harness.settle();
    await harness.setQuery("launch");
    expect(harness.get().loading).toBe(true);
    await harness.settle();
    expect(harness.get().loading).toBe(false);
    const titles = harness.get().results.map((result) => result.title);
    expect(titles).toEqual(["Launch Planning"]);
    expect(
      titles.every(
        (title) =>
          !title.startsWith("chan-") &&
          !title.startsWith("rt-") &&
          !title.startsWith("agent-"),
      ),
    ).toBe(true);
    expect(harness.get().hasMore).toBe(true);
    harness.unmount();
  });

  test("loadMore appends the next page without re-debouncing", async () => {
    const harness = mount("");
    await harness.settle();
    await harness.setQuery("launch");
    await harness.settle();
    act(() => {
      harness.get().loadMore();
    });
    await harness.settle();
    const titles = harness.get().results.map((result) => result.title);
    expect(titles).toEqual(["Launch Planning", "Launch Retro"]);
    expect(harness.get().hasMore).toBe(true);
    harness.unmount();
  });

  test("changing the query resets pagination back to the first page", async () => {
    const harness = mount("");
    await harness.settle();
    await harness.setQuery("launch");
    await harness.settle();
    act(() => {
      harness.get().loadMore();
    });
    await harness.settle();
    expect(harness.get().results).toHaveLength(2);

    await harness.setQuery("triage");
    await harness.settle();
    expect(harness.get().results.map((result) => result.title)).toEqual([
      "Support Triage",
    ]);
    harness.unmount();
  });

  test("a fetch failure in any source is reported as an error rather than a partial result", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let latest: UseEntitySearchResult | undefined;

    function Host() {
      latest = useEntitySearch({
        query: "launch",
        enabled: true,
        pageSize: 10,
        debounceMs: 5,
        sources: [
          { category: "channels", fetch: () => Promise.resolve(CHANNELS) },
          {
            category: "routines",
            fetch: () => Promise.reject(new Error("boom")),
          },
        ],
      });
      return null;
    }

    act(() => {
      root.render(createElement(Host));
    });
    await act(() => sleep(30));
    expect(latest?.error).toBe(true);
    expect(latest?.loading).toBe(false);
    root.unmount();
  });

  test("searches across all sources and preserves source order in results", async () => {
    const harness = mount("");
    await harness.settle();
    await harness.setQuery("launch");
    await harness.settle();
    // Load all three "launch" matches across channels/routines/agents
    act(() => harness.get().loadMore());
    await harness.settle();
    act(() => harness.get().loadMore());
    await harness.settle();
    const results = harness.get().results;
    const titles = results.map((r) => r.title);
    expect(titles).toEqual(["Launch Planning", "Launch Retro", "Launch Agent"]);
    const categories = results.map((r) => r.category);
    expect(categories).toEqual(["channels", "routines", "agents"]);
    harness.unmount();
  });
});
