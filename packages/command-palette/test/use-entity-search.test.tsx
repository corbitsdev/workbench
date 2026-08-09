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
const RUNS = [
  { id: "run-1", name: "Nightly Digest" },
  { id: "run-2", name: "Launch Retro" },
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
      listChannels: () => Promise.resolve(CHANNELS),
      listRuns: () => Promise.resolve(RUNS),
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
        (title) => !title.startsWith("chan-") && !title.startsWith("run-"),
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
    expect(harness.get().hasMore).toBe(false);
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

  test("a fetch failure is reported as an error rather than an empty result", async () => {
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
        listChannels: () => Promise.reject(new Error("boom")),
        listRuns: () => Promise.resolve(RUNS),
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
});
