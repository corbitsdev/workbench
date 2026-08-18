import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { InsightsRun } from "../src/insights-api";
import { InsightsRunsHistory } from "../src/pages/insights-page";
import { TestQueryProvider } from "./test-query-provider";

globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.reject(
    new Error("no network in insights row-activation tests"),
  )) as typeof fetch;

function insightsRun(
  partial: Partial<InsightsRun> & Pick<InsightsRun, "id" | "status">,
): InsightsRun {
  return {
    tenantId: "t1",
    definitionId: "wfd_a",
    definitionName: "Research brief",
    address: "run@bench.example",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    routineId: partial.routineId ?? null,
    routineName: partial.routineName ?? null,
    ...partial,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
  return container;
}

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

describe("Insights row activation (hand-rolled onRowActivate helper)", () => {
  test("clicking a definition-history row navigates via onOpenRun", () => {
    const opened: string[] = [];
    const el = mount(
      <TestQueryProvider>
        <InsightsRunsHistory
          runs={[insightsRun({ id: "run_1", status: "deployed" })]}
          loading={false}
          nextCursor={null}
          onOpenRun={(id) => opened.push(id)}
          onBack={() => undefined}
        />
      </TestQueryProvider>,
    );

    const row = el.querySelector('[data-ctx-insights-run="run_1"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute("role")).toBe("button");
    expect(row?.getAttribute("tabindex")).toBe("0");

    act(() => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toEqual(["run_1"]);
  });

  test("pressing Enter on a definition-history row activates it", () => {
    const opened: string[] = [];
    const el = mount(
      <TestQueryProvider>
        <InsightsRunsHistory
          runs={[insightsRun({ id: "run_2", status: "deployed" })]}
          loading={false}
          nextCursor={null}
          onOpenRun={(id) => opened.push(id)}
          onBack={() => undefined}
        />
      </TestQueryProvider>,
    );

    const row = el.querySelector('[data-ctx-insights-run="run_2"]');
    act(() => {
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(opened).toEqual(["run_2"]);
  });

  test("pressing Space on a definition-history row activates it", () => {
    const opened: string[] = [];
    const el = mount(
      <TestQueryProvider>
        <InsightsRunsHistory
          runs={[insightsRun({ id: "run_3", status: "deployed" })]}
          loading={false}
          nextCursor={null}
          onOpenRun={(id) => opened.push(id)}
          onBack={() => undefined}
        />
      </TestQueryProvider>,
    );

    const row = el.querySelector('[data-ctx-insights-run="run_3"]');
    act(() => {
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
    });
    expect(opened).toEqual(["run_3"]);
  });

  test("an unrelated key (e.g. Tab) does not activate the row", () => {
    const opened: string[] = [];
    const el = mount(
      <TestQueryProvider>
        <InsightsRunsHistory
          runs={[insightsRun({ id: "run_4", status: "deployed" })]}
          loading={false}
          nextCursor={null}
          onOpenRun={(id) => opened.push(id)}
          onBack={() => undefined}
        />
      </TestQueryProvider>,
    );

    const row = el.querySelector('[data-ctx-insights-run="run_4"]');
    act(() => {
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(opened).toEqual([]);
  });
});
