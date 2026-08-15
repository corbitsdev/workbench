import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createInsightsWindow,
  EMPTY_OVERALL_USAGE,
  type DayActivity,
  type OverallUsage,
} from "@corbits/insights/client";

import type { APIQuery } from "@corbits/api-query";
import { BenchProvider } from "../src/bench-context";
import {
  type InsightsRun,
  type RunTrace,
  type TaskLeg,
  type ToolCall,
} from "../src/insights-api";
import { NavigationProvider } from "../src/navigation";
import {
  InsightsPage,
  InsightsRunDetail,
  InsightsRunsHistory,
} from "../src/pages/insights-page";
import type { Routine } from "../src/routines-api";
import { TestQueryProvider } from "./test-query-provider";

const range = createInsightsWindow(7, new Date("2026-01-15T18:00:00.000Z"));

const emptyRuns: APIQuery<{ data: readonly never[] }> = {
  kind: "ready",
  data: { data: [] },
};
const emptyRoutines: APIQuery<readonly Routine[]> = {
  kind: "ready",
  data: [],
};

globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.reject(
    new Error("no network in insights page tests"),
  )) as typeof fetch;

function renderLanding(args: {
  readonly summary: APIQuery<OverallUsage>;
  readonly activity: APIQuery<readonly DayActivity[]>;
  readonly byTool: APIQuery<readonly ToolCall[]>;
}): string {
  return renderToStaticMarkup(
    <TestQueryProvider>
      <NavigationProvider navigate={() => undefined}>
        <BenchProvider>
          <InsightsPage
            path="/insights"
            summary={args.summary}
            activity={args.activity}
            byTool={args.byTool}
            runs={emptyRuns}
            routines={emptyRoutines}
            range={range}
          />
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>,
  );
}

describe("InsightsPage usage honesty", () => {
  test("ready-empty usage renders zero KPIs, not a load error", () => {
    const markup = renderLanding({
      summary: { kind: "ready", data: EMPTY_OVERALL_USAGE },
      activity: { kind: "ready", data: [] },
      byTool: { kind: "ready", data: [] },
    });
    expect(markup).not.toContain("load insights");
    expect(markup).toContain("$0.00");
    expect(markup).toContain("Insights");
  });

  test("summary API error surfaces load failure instead of zeros", () => {
    const markup = renderLanding({
      summary: {
        kind: "error",
        message: "usage endpoint failed",
        retry: () => undefined,
      },
      activity: { kind: "ready", data: [] },
      byTool: { kind: "ready", data: [] },
    });
    expect(markup).toContain("load insights");
    expect(markup).toContain("usage endpoint failed");
    expect(markup).not.toContain("$0.00");
  });

  test("activity API error surfaces load failure", () => {
    const markup = renderLanding({
      summary: { kind: "ready", data: EMPTY_OVERALL_USAGE },
      activity: {
        kind: "error",
        message: "activity schema mismatch",
        retry: () => undefined,
      },
      byTool: { kind: "ready", data: [] },
    });
    expect(markup).toContain("load insights");
    expect(markup).toContain("activity schema mismatch");
  });

  test("byTool API error surfaces load failure", () => {
    const markup = renderLanding({
      summary: { kind: "ready", data: EMPTY_OVERALL_USAGE },
      activity: { kind: "ready", data: [] },
      byTool: {
        kind: "error",
        message: "tools route 500",
        retry: () => undefined,
      },
    });
    expect(markup).toContain("load insights");
    expect(markup).toContain("tools route 500");
  });
});

const purposeRun = {
  id: "run_1",
  tenantId: "tnt_1",
  definitionId: "wfd_1",
  definitionName: "Morning brief",
  address: "run@agents.example",
  status: "running",
  createdAt: "2026-01-15T12:00:00.000Z",
  updatedAt: "2026-01-15T12:00:00.000Z",
} as const;

function renderAtPath(path: string): string {
  return renderToStaticMarkup(
    <TestQueryProvider>
      <NavigationProvider navigate={() => undefined}>
        <BenchProvider>
          <InsightsPage
            path={path}
            summary={{ kind: "ready", data: EMPTY_OVERALL_USAGE }}
            activity={{ kind: "ready", data: [] }}
            byTool={{ kind: "ready", data: [] }}
            runs={{ kind: "ready", data: { data: [purposeRun] } }}
            routines={emptyRoutines}
            range={range}
          />
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>,
  );
}

describe("InsightsPage breadcrumbs", () => {
  test("runs history puts an Insights / Run history trail in the top bar", () => {
    const markup = renderAtPath("/insights/runs");
    expect(markup).toContain('data-testid="stage-top-bar"');
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain(">Insights</button>");
    expect(markup).toContain('aria-current="page">Run history</span>');
    expect(markup).not.toContain("insights-crumb");
  });

  test("run detail puts a Runs / {run} trail in the top bar", () => {
    const markup = renderAtPath("/insights/runs/run_1");
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain(">Runs</button>");
    expect(markup).toContain('aria-current="page">Morning brief</span>');
    expect(markup).not.toContain("insights-crumb");
  });
});

describe("InsightsPage run-detail stat strip", () => {
  test("shows the Owner/Steps/Completed/Failed/Duration set, honestly dashed without a trace", () => {
    const markup = renderAtPath("/insights/runs/run_1");
    expect(markup).toContain(">Owner<");
    expect(markup).toContain(">Steps<");
    expect(markup).toContain(">Completed<");
    expect(markup).toContain(">Failed<");
    expect(markup).toContain(">Duration<");
    expect(markup).not.toContain(">Status<");
    expect(markup).not.toContain(">Bench<");
  });

  test("while the trace is loading, the KPIs render an ellipsis, not a dash", () => {
    const markup = renderToStaticMarkup(
      <InsightsRunDetail
        runId="run_1"
        run={purposeRun}
        trace={{ kind: "loading" }}
        chainLegs={null}
        onOpenRun={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(markup).toContain(">…<");
    // Owner is genuinely absent from WorkflowRunResponse today (not a
    // loading state), so it keeps its dash even while the trace loads.
    expect(markup).toContain(">—<");
  });

  test("once the trace is ready-but-empty, the KPIs fall back to a genuine dash", () => {
    const markup = renderToStaticMarkup(
      <InsightsRunDetail
        runId="run_1"
        run={purposeRun}
        trace={{
          kind: "ready",
          data: { runId: "run_1", spans: null, absent: "no trace reader" },
        }}
        chainLegs={null}
        onOpenRun={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(markup).not.toContain(">…<");
  });
});

describe("InsightsPage trace timeline honesty", () => {
  const measuredSpan = {
    id: "turn_1",
    label: "Turn 1",
    kind: "turn",
    start: 0,
    end: 5000,
    durationMs: 5000,
    tokens: null,
    phase: "ok",
    error: null,
    timingSource: "measured",
  } as const;

  const ordinalSpanWithNoDuration = {
    id: "part_1",
    label: "echo",
    kind: "tool",
    start: 1200,
    end: 1200,
    durationMs: null,
    tokens: null,
    phase: "ok",
    error: null,
    timingSource: "ordinal",
  } as const;

  function traceQuery(spans: RunTrace["spans"]): APIQuery<RunTrace> {
    return {
      kind: "ready",
      data: { runId: "run_1", spans } as RunTrace,
    };
  }

  test("a tool span positioned only by event order never gets a fabricated duration", () => {
    const markup = renderToStaticMarkup(
      <InsightsRunDetail
        runId="run_1"
        run={purposeRun}
        trace={traceQuery([measuredSpan, ordinalSpanWithNoDuration])}
        chainLegs={null}
        onOpenRun={() => undefined}
        onBack={() => undefined}
      />,
    );
    // The ordinal span's own duration cell reads as an honest dash, never a
    // computed 0ms/instant duration derived from its equal start/end.
    expect(markup).toContain(">—<");
    expect(markup).not.toContain("0ms");
  });

  test("a turn span with real measured timing still renders its actual duration", () => {
    const markup = renderToStaticMarkup(
      <InsightsRunDetail
        runId="run_1"
        run={purposeRun}
        trace={traceQuery([measuredSpan])}
        chainLegs={null}
        onOpenRun={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(markup).toContain("5.0s");
  });
});

function leg(partial: Partial<TaskLeg> & Pick<TaskLeg, "position">): TaskLeg {
  return {
    definitionId: "wfd_agent",
    prompt: "do the thing",
    status: "pending",
    runId: null,
    startedAt: null,
    settledAt: null,
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

describe("InsightsRunDetail chain strip", () => {
  const readyEmptyTrace: APIQuery<RunTrace> = {
    kind: "ready",
    data: { runId: "run_2", spans: [] },
  };

  test("renders legs in order with the current leg marked distinct", () => {
    const legs = [
      leg({
        position: 0,
        definitionId: "wfd_first",
        status: "done",
        runId: "run_1",
        startedAt: "2026-01-01T00:00:00.000Z",
        settledAt: "2026-01-01T00:00:05.000Z",
      }),
      leg({
        position: 1,
        definitionId: "wfd_second",
        status: "running",
        runId: "run_2",
        startedAt: "2026-01-01T00:00:05.000Z",
      }),
      leg({ position: 2, definitionId: "wfd_third" }),
    ];

    const el = mount(
      <InsightsRunDetail
        runId="run_2"
        run={null}
        trace={readyEmptyTrace}
        chainLegs={legs}
        onOpenRun={() => undefined}
        onBack={() => undefined}
      />,
    );

    const steps = el.querySelectorAll("[data-chain-step]");
    expect(steps.length).toBe(3);
    expect(steps[0]?.textContent).toContain("Step 1 of 3");
    expect(steps[1]?.textContent).toContain("Step 2 of 3");
    expect(steps[2]?.textContent).toContain("Step 3 of 3");
    expect(steps[1]?.getAttribute("aria-current")).toBe("step");
    expect(steps[0]?.getAttribute("aria-current")).toBeNull();
    expect(steps[2]?.getAttribute("aria-current")).toBeNull();
  });

  test("clicking a completed leg with a runId navigates to that leg's run", () => {
    const legs = [
      leg({
        position: 0,
        definitionId: "wfd_first",
        status: "done",
        runId: "run_1",
      }),
      leg({
        position: 1,
        definitionId: "wfd_second",
        status: "running",
        runId: "run_2",
      }),
    ];
    const opened: string[] = [];

    const el = mount(
      <InsightsRunDetail
        runId="run_2"
        run={null}
        trace={readyEmptyTrace}
        chainLegs={legs}
        onOpenRun={(runId) => opened.push(runId)}
        onBack={() => undefined}
      />,
    );

    const firstStep = el.querySelectorAll("[data-chain-step]")[0];
    expect(firstStep?.tagName).toBe("BUTTON");
    act(() => {
      firstStep?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(opened).toEqual(["run_1"]);
  });

  test("a pending leg with no runId is not clickable", () => {
    const legs = [
      leg({
        position: 0,
        definitionId: "wfd_first",
        status: "done",
        runId: "run_1",
      }),
      leg({ position: 1, definitionId: "wfd_second", status: "pending" }),
    ];

    const el = mount(
      <InsightsRunDetail
        runId="run_1"
        run={null}
        trace={readyEmptyTrace}
        chainLegs={legs}
        onOpenRun={() => undefined}
        onBack={() => undefined}
      />,
    );

    const pendingStep = el.querySelectorAll("[data-chain-step]")[1];
    expect(pendingStep?.tagName).not.toBe("BUTTON");
  });

  test("a chain-less run (no owning task) renders no chain strip", () => {
    const el = mount(
      <InsightsRunDetail
        runId="run_solo"
        run={null}
        trace={readyEmptyTrace}
        chainLegs={null}
        onOpenRun={() => undefined}
        onBack={() => undefined}
      />,
    );

    expect(el.querySelector("[data-chain-step]")).toBeNull();
    expect(el.querySelector("[data-insights-chain-strip]")).toBeNull();
  });

  test("a single-leg task renders no chain strip", () => {
    const el = mount(
      <InsightsRunDetail
        runId="run_solo"
        run={null}
        trace={readyEmptyTrace}
        chainLegs={[leg({ position: 0, runId: "run_solo" })]}
        onOpenRun={() => undefined}
        onBack={() => undefined}
      />,
    );

    expect(el.querySelector("[data-insights-chain-strip]")).toBeNull();
  });
});

function insightsRun(
  partial: Partial<InsightsRun> & Pick<InsightsRun, "id" | "status">,
): InsightsRun {
  return {
    tenantId: "t1",
    definitionId: "wfd_a",
    definitionName: "Research brief",
    address: "addr",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("InsightsRunsHistory definition grouping", () => {
  test("renders one table per definition, newest run first within each", () => {
    const runs = [
      insightsRun({
        id: "a1",
        status: "deployed",
        definitionId: "wfd_a",
        definitionName: "Research brief",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      insightsRun({
        id: "b1",
        status: "running",
        definitionId: "wfd_b",
        definitionName: "Weekly digest",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      insightsRun({
        id: "a2",
        status: "error",
        definitionId: "wfd_a",
        definitionName: "Research brief",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    ];

    const el = mount(
      <InsightsRunsHistory
        runs={runs}
        loading={false}
        onOpenRun={() => undefined}
        onBack={() => undefined}
      />,
    );

    const groups = el.querySelectorAll("[data-definition-group]");
    expect(groups.length).toBe(2);
    expect(groups[0]?.getAttribute("data-definition-group")).toBe("wfd_a");
    const firstGroupRows = groups[0]?.querySelectorAll("tbody tr") ?? [];
    expect(firstGroupRows.length).toBe(2);
    expect(firstGroupRows[0]?.textContent).toContain("error");
  });

  test("no runs renders an honest empty state, not empty tables", () => {
    const el = mount(
      <InsightsRunsHistory
        runs={[]}
        loading={false}
        onOpenRun={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(el.querySelector("[data-definition-group]")).toBeNull();
    expect(el.textContent).toContain("No purpose runs yet");
  });
});
