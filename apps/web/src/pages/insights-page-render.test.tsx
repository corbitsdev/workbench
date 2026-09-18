// A malformed percent-escape on a deep link must render the same landing
// dashboard any other unrecognized path gets — never a blank page.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { APIQuery } from "@/lib/api-query";

import { InsightsPage } from "./insights-page";
import { BenchContext } from "../bench-context";
import type { BenchState } from "../bench-context";
import type { InsightsRun } from "../insights-api";
import { NavigationProvider } from "../navigation";

type RunsStub = { data: readonly InsightsRun[]; nextCursor: string | null };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const readyEmpty = <T,>(data: T): APIQuery<T> => ({ kind: "ready", data });

const benchState: BenchState = {
  memberships: { kind: "ready", data: { data: [], nextCursor: null } },
  benchMemberships: [],
  selectedTenantId: "tnt_bench_a",
  selectedPrincipalId: "prn_bench_a",
  selectTenant: () => {},
  onBenchCreated: () => {},
};

function InsightsPageAtPath({
  path,
  runs = { data: [], nextCursor: null },
}: {
  readonly path: string;
  readonly runs?: RunsStub;
}) {
  return (
    <NavigationProvider navigate={() => {}}>
      <BenchContext.Provider value={benchState}>
        <InsightsPage path={path} runs={readyEmpty(runs)} routines={readyEmpty([])} />
      </BenchContext.Provider>
    </NavigationProvider>
  );
}

function render(path: string, runs?: RunsStub) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<InsightsPageAtPath path={path} {...(runs === undefined ? {} : { runs })} />);
  });
  return container;
}

describe("InsightsPage with a malformed URL escape", () => {
  test("a malformed run deep link still renders the landing dashboard, not run detail", () => {
    const el = render("/insights/runs/%");
    expect(el.textContent).not.toBe("");
    expect(el.textContent).toContain("Insights");
    expect(el.textContent).toContain("Recent runs");
  });
});

describe("InsightsPage 'Running now' strip", () => {
  test("no in-flight runs: the strip renders nothing, not an empty-state fixture", () => {
    const el = render("/insights", { data: [], nextCursor: null });
    expect(el.textContent).not.toContain("Running now");
  });

  test("a genuinely running run surfaces in the strip by name", () => {
    const el = render("/insights", {
      data: [
        {
          id: "run_1",
          tenantId: "tnt_bench_a",
          definitionId: "wfd_a",
          definitionName: "Weekly digest",
          address: "addr",
          status: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          routineId: null,
          routineName: null,
        },
      ],
      nextCursor: null,
    });
    expect(el.textContent).toContain("Running now");
    expect(el.textContent).toContain("1 in progress");
    expect(el.textContent).toContain("Weekly digest");
  });

  // Liveness is not a windowed property: a run started long ago must not
  // disappear from the strip or the "Running now" KPI.
  test("a run started 8 days ago that is still running stays in the strip and the KPI", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const el = render("/insights", {
      data: [
        {
          id: "run_long_haul",
          tenantId: "tnt_bench_a",
          definitionId: "wfd_a",
          definitionName: "Long haul",
          address: "addr",
          status: "running",
          createdAt: eightDaysAgo,
          updatedAt: eightDaysAgo,
          routineId: null,
          routineName: null,
        },
      ],
      nextCursor: null,
    });
    expect(el.textContent).toContain("Running now");
    expect(el.textContent).toContain("1 in progress");
    expect(el.textContent).toContain("Long haul");
    expect(el.textContent).toContain("in flight");
  });

  test("the elapsed label ticks forward while a run is live, not frozen at first render", async () => {
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const el = render("/insights", {
      data: [
        {
          id: "run_ticking",
          tenantId: "tnt_bench_a",
          definitionId: "wfd_a",
          definitionName: "Weekly digest",
          address: "addr",
          status: "running",
          createdAt: startedAt,
          updatedAt: startedAt,
          routineId: null,
          routineName: null,
        },
      ],
      nextCursor: null,
    });
    const before = el.textContent;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    });
    expect(el.textContent).not.toBe(before);
  });
});
