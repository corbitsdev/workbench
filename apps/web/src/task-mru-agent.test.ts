import { afterEach, describe, expect, test } from "bun:test";

import {
  loadMostRecentTaskAgent,
  saveMostRecentTaskAgent,
} from "./task-mru-agent";

afterEach(() => {
  window.localStorage.clear();
});

describe("task MRU agent", () => {
  test("returns null before anything is saved", () => {
    expect(loadMostRecentTaskAgent("tnt_1")).toBeNull();
  });

  test("round-trips the last saved agent for a tenant", () => {
    saveMostRecentTaskAgent("tnt_1", "wfd_incident_bot");
    expect(loadMostRecentTaskAgent("tnt_1")).toBe("wfd_incident_bot");
  });

  test("a later save overwrites the earlier one", () => {
    saveMostRecentTaskAgent("tnt_1", "wfd_first");
    saveMostRecentTaskAgent("tnt_1", "wfd_second");
    expect(loadMostRecentTaskAgent("tnt_1")).toBe("wfd_second");
  });

  test("keeps separate benches from mixing histories", () => {
    saveMostRecentTaskAgent("tnt_1", "wfd_bench_one");
    saveMostRecentTaskAgent("tnt_2", "wfd_bench_two");
    expect(loadMostRecentTaskAgent("tnt_1")).toBe("wfd_bench_one");
    expect(loadMostRecentTaskAgent("tnt_2")).toBe("wfd_bench_two");
  });
});
