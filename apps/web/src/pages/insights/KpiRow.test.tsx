import "../../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { KpiRow } from "./KpiRow";
import type { ActivityOverview } from "../../lib/hub-api";

const minimalOverview = {
  tenantId: "t-1",
  range: {},
  artifacts: { total: 12, createdInRange: 5, byStatus: [], byKind: [] },
  workflowRuns: {
    executionRecords: 7,
    executionsStartedInRange: 3,
    activeExecutions: 2,
    byStatus: [],
    byKind: [],
    deploymentsIndexed: 1,
  },
  conversations: { total: 0, createdInRange: 0 },
  messages: { total: 0, createdInRange: 0 },
  agentActivity: { active: 0, idle: 0 },
  byPerson: [],
  inference: {
    summary: {
      tenantId: "t-1",
      turnCount: 10,
      toolCallCount: 3,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      thinkingTokens: 5,
      failedTurnCount: 0,
      toolErrorCount: 0,
    },
    previousSummary: {
      tenantId: "t-1",
      turnCount: 8,
      toolCallCount: 2,
      inputTokens: 80,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      thinkingTokens: 0,
      failedTurnCount: 0,
      toolErrorCount: 0,
    },
    byAgent: [],
    byInstance: [],
  },
  dailySeries: [],
  agentInstances: { active: 0, startedInRange: 0, endedInRange: 0, total: 0 },
  metricsBucket: "day" as const,
  metricsSeries: [],
  models: [],
  byModel: [],
  tokensRecordedFrom: "2026-01-01",
  byWorkflowType: [],
} as ActivityOverview;

describe("KpiRow", () => {
  afterEach(() => cleanup());

  it("renders the 'This range' header and all KPI tiles", () => {
    render(
      <KpiRow
        data={minimalOverview}
        activePeople={4}
        costTotal={42.5}
        costTokens={185}
        costUnavailable={false}
      />,
    );

    expect(screen.getByText("This range")).toBeDefined();

    const container = screen.getByText("This range").closest("div")!;
    const kpi = within(container);

    expect(kpi.getByText("Cost")).toBeDefined();
    expect(kpi.getByText("$42.50")).toBeDefined();
    expect(kpi.getByText("185 tokens")).toBeDefined();

    expect(kpi.getByText("Total activity")).toBeDefined();
    expect(kpi.getByText("13")).toBeDefined(); // 10 + 3
    expect(kpi.getByText("chats + tool calls")).toBeDefined();

    expect(kpi.getByText("Active actors")).toBeDefined();
    expect(kpi.getByText("4")).toBeDefined();

    expect(kpi.getByText("Workflow runs")).toBeDefined();
    expect(kpi.getByText("3")).toBeDefined();
    expect(kpi.getByText("2 active")).toBeDefined();

    expect(kpi.getByText("Artifacts")).toBeDefined();
    expect(kpi.getByText("12")).toBeDefined();
    expect(kpi.getByText("5 in range")).toBeDefined();
  });

  it("shows unavailable pricing state and null cost", () => {
    render(
      <KpiRow
        data={minimalOverview}
        activePeople={1}
        costTotal={null}
        costTokens={0}
        costUnavailable
      />,
    );

    expect(screen.getByText("pricing unavailable")).toBeDefined();
    expect(screen.getByText("—")).toBeDefined();
  });
});
