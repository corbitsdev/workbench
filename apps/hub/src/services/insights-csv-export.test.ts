import { describe, expect, it } from "bun:test";

import type { ActivityOverview } from "./activity-overview";
import {
  buildInsightsExportCsv,
  insightsExportFilename,
} from "./insights-csv-export";

function minimalOverview(
  overrides: Partial<ActivityOverview> = {},
): ActivityOverview {
  return {
    tenantId: "tn_test",
    range: { startDate: "2026-07-01", endDate: "2026-07-31" },
    artifacts: {
      total: 0,
      createdInRange: 0,
      byKind: [],
    },
    workflowRuns: {
      executionRecords: 0,
      executionsStartedInRange: 0,
      activeExecutions: 0,
      byStatus: [],
      byKind: [],
      deploymentsIndexed: 0,
    },
    agentInstances: {
      active: 0,
      startedInRange: 0,
      endedInRange: 0,
      total: 0,
    },
    agentActivity: { active: 0, idle: 0 },
    conversations: { total: 0, createdInRange: 0 },
    messages: { total: 0, createdInRange: 0 },
    dailySeries: [],
    metricsBucket: "week",
    metricsSeries: [
      {
        bucketStart: "2026-06-30",
        agentsDeployed: 1,
        agentsActive: 2,
        tokensSpent: 100,
        artifactsCreated: 3,
      },
    ],
    models: [],
    byModel: [
      {
        model: "gpt-4",
        turnCount: 5,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
      },
    ],
    pricedByModel: null,
    tokensRecordedFrom: null,
    byPerson: [
      {
        principalId: "prn_1",
        name: "Alex",
        isSelf: false,
        turnCount: 5,
        toolCallCount: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        cost: {
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0,
            cacheWrite: 0,
            thinking: 0,
            total: 0.03,
          },
          unpricedModels: [],
          hasUnpriced: false,
        },
      },
    ],
    byWorkflowType: [
      {
        kind: "demo-flow",
        turnCount: 2,
        toolCallCount: 0,
        inputTokens: 4,
        outputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        cost: null,
      },
    ],
    inference: {
      summary: {
        tenantId: "tn_test",
        turnCount: 0,
        failedTurnCount: 0,
        toolCallCount: 0,
        toolErrorCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
      },
      previousSummary: null,
      byAgent: [],
      byInstance: [],
    },
    ...overrides,
  };
}

describe("buildInsightsExportCsv", () => {
  it("includes metrics series and breakdown sections with bucket metadata", () => {
    const csv = buildInsightsExportCsv(minimalOverview());
    expect(csv).toContain("metrics_bucket");
    expect(csv).toContain("week");
    expect(csv).toContain("[metrics_series]");
    expect(csv).toContain("2026-06-30,1,2,100,3");
    expect(csv).toContain("[by_person]");
    expect(csv).toContain("prn_1,Alex,5,1,10,20,0,0,0,0.03");
    expect(csv).toContain("[by_model]");
    expect(csv).toContain("gpt-4,5,10,20,0,0,0");
    expect(csv).toContain("[by_workflow_type]");
    expect(csv).toContain("demo-flow,2,0,4,6,");
  });
});

describe("insightsExportFilename", () => {
  it("embeds bucket and range in the filename", () => {
    expect(
      insightsExportFilename({
        bucket: "month",
        range: { startDate: "2026-01-01", endDate: "2026-06-30" },
      }),
    ).toBe("insights-month-2026-01-01_2026-06-30.csv");
  });
});
