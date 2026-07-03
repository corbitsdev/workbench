/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

type Entry = {
  kind: string;
  id: string;
  sourceTable: string;
  timestamp: string;
  summary: string | null;
};

let activityError: Error | null = null;
let activityEntries: Entry[] = [];
let activityCalls: { tenantId: string; principalId: string; limit?: number }[] =
  [];

mock.module("@workbench/client", () => ({
  getPrincipalActivity: (
    _options: unknown,
    params: { tenantId: string; principalId: string; limit?: number },
  ) => {
    activityCalls.push({
      tenantId: params.tenantId,
      principalId: params.principalId,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    if (activityError) return Promise.reject(activityError);
    return Promise.resolve({ entries: activityEntries, nextCursor: null });
  },
}));

import {
  RecentActivity,
  RECENT_ACTIVITY_LIMIT,
  traceHrefForEntry,
} from "./RecentActivity";

function renderFeed(tenantId = "t1", principalId = "p1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RecentActivity tenantId={tenantId} principalId={principalId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  activityError = null;
  activityEntries = [];
  activityCalls = [];
});

afterEach(() => {
  cleanup();
});

describe("traceHrefForEntry", () => {
  it("deep-links a workflow_run entry to its trace page by id", () => {
    expect(
      traceHrefForEntry({
        kind: "workflow_run",
        id: "run-9",
        sourceTable: "workflow_run_record",
        timestamp: "2026-07-01T10:00:00.000Z",
        summary: "reddit_scanner completed",
      } as never),
    ).toBe("/insights/trace/run-9");
  });

  it("returns null for non-run entries", () => {
    expect(
      traceHrefForEntry({
        kind: "message",
        id: "m1",
        sourceTable: "message",
        timestamp: "2026-07-01T10:00:00.000Z",
        summary: null,
      } as never),
    ).toBeNull();
  });
});

describe("RecentActivity", () => {
  it("renders the feed and links only workflow_run rows to the trace page", async () => {
    activityEntries = [
      {
        kind: "workflow_run",
        id: "run-9",
        sourceTable: "workflow_run_record",
        timestamp: "2026-07-01T10:00:00.000Z",
        summary: "reddit_scanner completed",
      },
      {
        kind: "message",
        id: "m1",
        sourceTable: "message",
        timestamp: "2026-07-01T09:00:00.000Z",
        summary: "hello there",
      },
    ];
    renderFeed();

    await waitFor(() => {
      expect(screen.getAllByTestId("recent-activity-entry").length).toBe(2);
    });
    screen.getByText("reddit_scanner completed");
    screen.getByText("hello there");

    await waitFor(() => {
      expect(activityCalls.length).toBe(1);
    });
    expect(activityCalls[0]).toEqual({
      tenantId: "t1",
      principalId: "p1",
      limit: RECENT_ACTIVITY_LIMIT,
    });

    const links = screen.getAllByRole("link");
    expect(
      links.some((l) => l.getAttribute("href") === "/insights/trace/run-9"),
    ).toBe(true);
    // The message row is not a link.
    expect(links.length).toBe(1);
  });

  it("shows an empty state when there is no activity", async () => {
    activityEntries = [];
    renderFeed();
    await waitFor(() => {
      screen.getByText("No recent activity recorded yet.");
    });
  });

  it("shows a legible error with retry when the feed fails", async () => {
    activityError = new Error("HTTP 500");
    renderFeed();
    await waitFor(() => {
      screen.getByText(/Couldn’t load recent activity/);
    });
    screen.getByText("Retry");
  });
});
