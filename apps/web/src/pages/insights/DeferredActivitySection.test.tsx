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

let calls: { tenantId: string }[] = [];

mock.module("@workbench/client", () => ({
  getTenantActivity: (
    _options: unknown,
    params: { tenantId: string; cursor?: string; limit?: number },
  ) => {
    calls.push({ tenantId: params.tenantId });
    const entries: Entry[] = [
      {
        kind: "workflow_run",
        id: "run-9",
        sourceTable: "workflow_run_record",
        timestamp: "2026-07-01T10:00:00.000Z",
        summary: "reddit_scanner completed",
      },
    ];
    return Promise.resolve({ entries, nextCursor: null });
  },
}));

import { DeferredActivitySection } from "./DeferredActivitySection";

function renderSection(tenantId = "t1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DeferredActivitySection tenantId={tenantId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  cleanup();
});

describe("DeferredActivitySection", () => {
  it("does NOT fetch the tenant-wide activity union on mount", async () => {
    renderSection();

    // The reveal affordance is shown, but the heavy union query never fired.
    await waitFor(() => {
      expect(screen.getByTestId("reveal-tenant-activity")).toBeDefined();
    });
    expect(calls.length).toBe(0);
    // The feed itself is not mounted, so no loading skeleton and no rows.
    expect(screen.queryByTestId("tenant-activity-feed")).toBeNull();
  });

  it("fetches only after the section is opened", async () => {
    renderSection();

    fireEvent.click(screen.getByTestId("reveal-tenant-activity"));

    await waitFor(() => {
      expect(screen.getByTestId("tenant-activity-feed")).toBeDefined();
    });
    // Now — and only now — the union query ran, scoped to the tenant.
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ tenantId: "t1" });
    // The reveal button is gone once the feed is open.
    expect(screen.queryByTestId("reveal-tenant-activity")).toBeNull();
  });
});
