import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createInsightsWindow,
  EMPTY_OVERALL_USAGE,
  type DayActivity,
  type OverallUsage,
} from "@corbits/insights/client";

import type { APIQuery } from "../src/api";
import { BenchProvider } from "../src/bench-context";
import { type ToolCall } from "../src/insights-api";
import { NavigationProvider } from "../src/navigation";
import { InsightsPage } from "../src/pages/insights-page";
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
      summary: { kind: "error", message: "usage endpoint failed" },
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
      activity: { kind: "error", message: "activity schema mismatch" },
      byTool: { kind: "ready", data: [] },
    });
    expect(markup).toContain("load insights");
    expect(markup).toContain("activity schema mismatch");
  });

  test("byTool API error surfaces load failure", () => {
    const markup = renderLanding({
      summary: { kind: "ready", data: EMPTY_OVERALL_USAGE },
      activity: { kind: "ready", data: [] },
      byTool: { kind: "error", message: "tools route 500" },
    });
    expect(markup).toContain("load insights");
    expect(markup).toContain("tools route 500");
  });
});

const purposeRun = {
  id: "run_1",
  tenantId: "tnt_1",
  tenantName: "Test Bench",
  definitionId: "wfd_1",
  definitionName: "Morning brief",
  address: "run@agents.example",
  status: "running",
  createdAt: "2026-01-15T12:00:00.000Z",
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
  test("runs history puts an Insights / Runs trail in the top bar", () => {
    const markup = renderAtPath("/insights/runs");
    expect(markup).toContain('data-testid="stage-top-bar"');
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain(">Insights</button>");
    expect(markup).toContain('aria-current="page">Runs</span>');
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
