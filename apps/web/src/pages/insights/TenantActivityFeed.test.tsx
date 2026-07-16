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

type Entry = {
  kind: string;
  id: string;
  sourceTable: string;
  timestamp: string;
  summary: string | null;
};

type Page = { entries: Entry[]; nextCursor: string | null };

let error: Error | null = null;
let pagesByCursor: Record<string, Page> = {};
let calls: { tenantId: string; cursor?: string; limit?: number }[] = [];

mock.module("@workbench/client", () => ({
  getTenantActivity: (
    _options: unknown,
    params: { tenantId: string; cursor?: string; limit?: number },
  ) => {
    calls.push({
      tenantId: params.tenantId,
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    if (error) return Promise.reject(error);
    const key = params.cursor ?? "";
    return Promise.resolve(
      pagesByCursor[key] ?? { entries: [], nextCursor: null },
    );
  },
}));

import { TenantActivityFeed } from "./TenantActivityFeed";

function renderFeed(tenantId = "t1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TenantActivityFeed tenantId={tenantId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  error = null;
  pagesByCursor = {};
  calls = [];
});

afterEach(() => {
  cleanup();
});

describe("TenantActivityFeed", () => {
  it("renders the tenant-wide feed and deep-links entity rows into their trace", async () => {
    pagesByCursor[""] = {
      entries: [
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
      ],
      nextCursor: null,
    };
    renderFeed();

    await waitFor(() => {
      expect(screen.getAllByTestId("tenant-activity-entry").length).toBe(2);
    });
    // Tenant-scoped call, no principal in the params.
    expect(calls[0]).toMatchObject({ tenantId: "t1" });
    expect(calls[0]).not.toHaveProperty("principalId");

    // The workflow_run row is a link into its trace; the message row is not.
    const links = screen.getAllByRole("link");
    expect(
      links.some((l) => l.getAttribute("href") === "/insights/trace/run-9"),
    ).toBe(true);
    expect(links.length).toBe(1);
  });

  it("paginates with Load more, passing the returned cursor", async () => {
    pagesByCursor[""] = {
      entries: [
        {
          kind: "workflow_run",
          id: "run-1",
          sourceTable: "workflow_run_record",
          timestamp: "2026-07-01T10:00:00.000Z",
          summary: "first",
        },
      ],
      nextCursor: "cursor-2",
    };
    pagesByCursor["cursor-2"] = {
      entries: [
        {
          kind: "workflow_run",
          id: "run-2",
          sourceTable: "workflow_run_record",
          timestamp: "2026-07-01T09:00:00.000Z",
          summary: "second",
        },
      ],
      nextCursor: null,
    };
    renderFeed();

    await waitFor(() => screen.getByText("first"));
    fireEvent.click(screen.getByTestId("tenant-activity-load-more"));

    await waitFor(() => screen.getByText("second"));
    expect(calls.some((c) => c.cursor === "cursor-2")).toBe(true);
    // Both pages are shown, and the button is gone once the cursor runs out.
    expect(screen.getAllByTestId("tenant-activity-entry").length).toBe(2);
    expect(screen.queryByTestId("tenant-activity-load-more")).toBeNull();
  });

  it("shows an empty state when the workbench has no activity", async () => {
    pagesByCursor[""] = { entries: [], nextCursor: null };
    renderFeed();
    await waitFor(() => screen.getByTestId("tenant-activity-empty"));
  });

  it("shows a legible error with retry when the feed fails", async () => {
    error = new Error("HTTP 500");
    renderFeed();
    await waitFor(() => screen.getByTestId("tenant-activity-error"));
    screen.getByText("Retry");
  });

  it("shows the grant/credential activity caveat only when such entries are present", async () => {
    pagesByCursor[""] = {
      entries: [
        {
          kind: "grant",
          id: "g1",
          sourceTable: "grant",
          timestamp: "2026-07-01T10:00:00.000Z",
          summary: "tool:x invoke allow",
        },
      ],
      nextCursor: null,
    };
    renderFeed();
    await waitFor(() => screen.getByTestId("permission-caveat"));
    expect(screen.getByTestId("permission-caveat").textContent).toMatch(
      /not an audit history/i,
    );
  });

  it("hides the grant/credential caveat when no such entries are loaded", async () => {
    pagesByCursor[""] = {
      entries: [
        {
          kind: "workflow_run",
          id: "run-1",
          sourceTable: "workflow_run_record",
          timestamp: "2026-07-01T10:00:00.000Z",
          summary: "done",
        },
      ],
      nextCursor: null,
    };
    renderFeed();
    await waitFor(() => screen.getAllByTestId("tenant-activity-entry").length);
    expect(screen.queryByTestId("permission-caveat")).toBeNull();
  });
});
