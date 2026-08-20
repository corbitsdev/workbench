// A malformed percent-escape on an Insights deep link
// (`/insights/workbench/%E0%A4%A`, `/insights/runs/%`) must render the
// same landing dashboard any other unrecognized Insights path gets — never
// a blank page, and never `InsightsWorkbenchPage`/the run-detail route with
// no entity to show (see `insights-path.ts`'s `parseInsightsPath`, which
// InsightsPage calls with the exact same `path` prop this test passes).

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { APIQuery } from "@corbits/api-query";
import { EMPTY_OVERALL_USAGE } from "@corbits/insights/client";

import { InsightsPage, useInsightsWindow } from "./insights-page";
import { BenchContext } from "../bench-context";
import type { BenchState } from "../bench-context";
import { NavigationProvider } from "../navigation";

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
  selectedTenantId: "tnt_bench_a",
  selectedPrincipalId: "prn_bench_a",
  selectTenant: () => {},
  onBenchCreated: () => {},
};

function InsightsPageAtPath({ path }: { readonly path: string }) {
  const range = useInsightsWindow();
  return (
    <NavigationProvider navigate={() => {}}>
      <BenchContext.Provider value={benchState}>
        <InsightsPage
          path={path}
          summary={readyEmpty(EMPTY_OVERALL_USAGE)}
          activity={readyEmpty([])}
          byTool={readyEmpty([])}
          runs={readyEmpty({ data: [], nextCursor: null })}
          routines={readyEmpty([])}
          workbenches={readyEmpty({ items: [] })}
          latency={{ kind: "loading" }}
          range={range}
          scope={null}
          resolveWorkbenchIdForTenant={() => null}
          scopeLabel="All workbenches"
        />
      </BenchContext.Provider>
    </NavigationProvider>
  );
}

function render(path: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<InsightsPageAtPath path={path} />);
  });
  return container;
}

describe("InsightsPage with a malformed URL escape", () => {
  test("a malformed workbench deep link still renders the landing dashboard", () => {
    const el = render("/insights/workbench/%E0%A4%A");
    expect(el.textContent).not.toBe("");
    expect(el.textContent).toContain("Insights");
    expect(el.textContent).toContain("All workbenches");
  });

  test("a malformed run deep link still renders the landing dashboard, not run detail", () => {
    const el = render("/insights/runs/%");
    expect(el.textContent).not.toBe("");
    expect(el.textContent).toContain("Insights");
    expect(el.textContent).toContain("All workbenches");
  });
});
