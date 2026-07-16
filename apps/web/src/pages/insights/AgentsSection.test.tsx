/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { RosterInstance } from "@workbench/client";
import type { ActivityOverview } from "../../lib/hub-api";

type TenantRoster = { instances: RosterInstance[]; runs: unknown[] };

let rosterResult: TenantRoster | null = null;

mock.module("@workbench/client", () => ({
  getTenantRoster: () =>
    Promise.resolve(rosterResult ?? { instances: [], runs: [] }),
}));

import { AgentsSection, displayForInstance } from "./AgentsSection";

function instance(overrides: Partial<RosterInstance> = {}): RosterInstance {
  return {
    instanceId: "ins_1",
    principalId: "prn_1",
    agentId: "agt_1",
    name: "Myra",
    status: "running",
    sessionCount: 1,
    templateKey: "myra",
    label: null,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    address: "ins_1@wb.local",
    ...overrides,
  };
}

function overview(): ActivityOverview {
  return {
    tenantId: "t1",
    range: {},
    artifacts: { total: 0, createdInRange: 0, byStatus: [], byKind: [] },
    workflowRuns: {
      executionRecords: 0,
      executionsStartedInRange: 0,
      activeExecutions: 0,
      byStatus: [],
      byKind: [],
      deploymentsIndexed: 0,
    },
    agentInstances: { active: 0, startedInRange: 0, endedInRange: 0, total: 0 },
    agentActivity: { active: 0, idle: 0 },
    conversations: { total: 0, createdInRange: 0 },
    messages: { total: 0, createdInRange: 0 },
    dailySeries: [],
    metricsBucket: "day",
    metricsSeries: [],
    models: [],
    byModel: [],
    pricedByModel: null,
    tokensRecordedFrom: "2000-01-01",
    byPerson: [],
    byWorkflowType: [],
    inference: {
      summary: {
        tenantId: "t1",
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
  } as ActivityOverview;
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentsSection tenantId="t1" data={overview()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rosterResult = null;
});
afterEach(() => cleanup());

describe("displayForInstance", () => {
  it("names a Myra chat instance from its thread title", () => {
    const result = displayForInstance(
      instance({ templateKey: "myra", label: "Renewal terms for Acme" }),
    );
    expect(result).toEqual({
      name: "Myra — Renewal terms for Acme",
      badgeLabel: "Chat",
    });
  });

  it("names a triage instance from its mail subject, stripping the stored prefix", () => {
    const result = displayForInstance(
      instance({
        templateKey: "myra-triage",
        label: "Triage: Q3 renewal follow-up",
      }),
    );
    expect(result).toEqual({
      name: "Myra — Q3 renewal follow-up",
      badgeLabel: "Inbox automation",
    });
  });

  it("falls back to the instance address when no title exists", () => {
    const result = displayForInstance(
      instance({ templateKey: "myra", label: null, address: "ins_1@wb.local" }),
    );
    expect(result).toEqual({
      name: "Myra — ins_1@wb.local",
      badgeLabel: "Chat",
    });
  });

  it("keeps a non-Myra agent's existing name with no badge", () => {
    const result = displayForInstance(
      instance({ templateKey: "oat", name: "Oat", label: null }),
    );
    expect(result).toEqual({ name: "Oat", badgeLabel: null });
  });

  it("classifies variant template keys by prefix, triage before chat", () => {
    expect(
      displayForInstance(
        instance({ templateKey: "myra-chat-kimi-k2-6", label: "Deep dive" }),
      ),
    ).toEqual({ name: "Myra — Deep dive", badgeLabel: "Chat" });
    expect(
      displayForInstance(
        instance({
          templateKey: "myra-triage-opus-4-8",
          label: "Triage: Invoice question",
        }),
      ),
    ).toEqual({
      name: "Myra — Invoice question",
      badgeLabel: "Inbox automation",
    });
  });
});

describe("AgentsSection", () => {
  it("renders one row per instance, sorted by most recent activity", async () => {
    rosterResult = {
      instances: [
        instance({
          instanceId: "ins_old",
          label: "Old thread",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
        }),
        instance({
          instanceId: "ins_new",
          label: "New thread",
          lastActivityAt: "2026-02-01T00:00:00.000Z",
        }),
      ],
      runs: [],
    };

    renderSection();

    await screen.findByText("Myra — New thread");
    const rows = screen.getAllByTestId("agent-instance-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Myra — New thread");
    expect(rows[1]?.textContent).toContain("Myra — Old thread");
  });

  it("paginates at 12 rows per page and pages through the remainder", async () => {
    rosterResult = {
      instances: Array.from({ length: 14 }, (_, i) =>
        instance({
          instanceId: `ins_${i}`,
          label: `Thread ${i}`,
          lastActivityAt: new Date(2026, 0, i + 1).toISOString(),
        }),
      ),
      runs: [],
    };

    renderSection();

    await waitFor(() =>
      expect(screen.getAllByTestId("agent-instance-row")).toHaveLength(12),
    );
    screen.getByText("Page 1 of 2 · 14 instances");
    expect((screen.getByText("Previous") as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() =>
      expect(screen.getAllByTestId("agent-instance-row")).toHaveLength(2),
    );
    screen.getByText("Page 2 of 2 · 14 instances");
    expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an honest empty state with no instances", async () => {
    rosterResult = { instances: [], runs: [] };
    renderSection();
    await screen.findByText("No agent instances in this workbench yet.");
  });
});
