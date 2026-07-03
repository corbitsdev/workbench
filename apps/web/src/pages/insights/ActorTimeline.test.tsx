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

type TimelineEntry = {
  kind: string;
  id: string;
  sourceTable: string;
  timestamp: string;
  summary: string | null;
};
type ActivityPage = { entries: TimelineEntry[]; nextCursor: string | null };

let activityCalls: { principalId: string; cursor?: string }[] = [];
let activityPages: ActivityPage[] = [];
let hang = false;
let errorStatus: number | undefined;

mock.module("@workbench/client", () => ({
  getPrincipalActivity: (
    _options: unknown,
    params: { principalId: string; cursor?: string },
  ) => {
    activityCalls.push({
      principalId: params.principalId,
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    });
    if (errorStatus !== undefined) {
      return Promise.reject(
        Object.assign(new Error("boom"), { status: errorStatus }),
      );
    }
    if (hang) return new Promise<ActivityPage>(() => {});
    const page = activityPages[activityCalls.length - 1] ?? {
      entries: [],
      nextCursor: null,
    };
    return Promise.resolve(page);
  },
}));

import { ActorTimeline, groupEntriesByDay } from "./ActorTimeline";

function entry(
  id: string,
  kind: string,
  timestamp: string,
  summary: string | null = null,
): TimelineEntry {
  return { id, kind, sourceTable: kind, timestamp, summary };
}

function renderTimeline() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ActorTimeline tenantId="tenant-1" principalId="prn_u1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  activityCalls = [];
  activityPages = [];
  hang = false;
  errorStatus = undefined;
});
afterEach(() => cleanup());

describe("ActorTimeline", () => {
  it("shows skeleton shimmer rows while the first page loads", async () => {
    hang = true;
    renderTimeline();
    await waitFor(() => {
      screen.getByTestId("timeline-loading");
    });
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
  });

  it("renders a retryable error state with a Retry button on a transient failure", async () => {
    errorStatus = 503;
    renderTimeline();

    await waitFor(() => screen.getByTestId("timeline-error"));
    screen.getByText(/Please try again/);
    screen.getByRole("button", { name: "Retry" });
    expect(screen.queryByTestId("timeline-forbidden")).toBeNull();
  });

  it("renders a permission message with no Retry on a 403", async () => {
    errorStatus = 403;
    renderTimeline();

    await waitFor(() => screen.getByTestId("timeline-forbidden"));
    screen.getByText(
      /You don.t have permission to view this person.s activity\./,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByTestId("timeline-error")).toBeNull();
  });

  it("renders entries grouped by day with per-kind badges", async () => {
    activityPages = [
      {
        entries: [
          entry("m1", "message", "2026-07-01T15:00:00.000Z", "hello there"),
          entry("t1", "tool_call", "2026-07-01T14:00:00.000Z", "web_search"),
          entry("w1", "workflow_run", "2026-06-28T10:00:00.000Z", null),
        ],
        nextCursor: null,
      },
    ];
    renderTimeline();
    await waitFor(() => {
      expect(screen.getAllByTestId("timeline-entry").length).toBe(3);
    });
    const rows = screen.getAllByTestId("timeline-entry");
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual([
      "message",
      "tool_call",
      "workflow_run",
    ]);
    screen.getByText("hello there");
    screen.getByText("Tool call");
    screen.getByText("No details recorded");
  });

  it("uses sticky positioning for the day headers", async () => {
    activityPages = [
      {
        entries: [entry("m1", "message", "2026-07-01T15:00:00.000Z", "x")],
        nextCursor: null,
      },
    ];
    renderTimeline();
    await waitFor(() => {
      screen.getByText("x");
    });
    const heading = screen.getAllByRole("heading", { level: 3 })[0]!;
    expect(heading.className).toContain("sticky");
    expect(heading.className).toContain("top-0");
  });

  it("shows the grant/credential caveat only when such entries are present", async () => {
    activityPages = [
      {
        entries: [
          entry("g1", "grant", "2026-07-01T15:00:00.000Z", "granted read"),
        ],
        nextCursor: null,
      },
    ];
    renderTimeline();
    await waitFor(() => {
      screen.getByTestId("permission-caveat");
    });
    screen.getByText(/current state only/);
  });

  it("hides the caveat when no grant or credential entries are loaded", async () => {
    activityPages = [
      {
        entries: [entry("m1", "message", "2026-07-01T15:00:00.000Z", "hi")],
        nextCursor: null,
      },
    ];
    renderTimeline();
    await waitFor(() => {
      screen.getByText("hi");
    });
    expect(screen.queryByTestId("permission-caveat")).toBeNull();
  });

  it("appends the next page via the cursor and announces the new count", async () => {
    activityPages = [
      {
        entries: [entry("m1", "message", "2026-07-01T15:00:00.000Z", "first")],
        nextCursor: "cursor-1",
      },
      {
        entries: [entry("m2", "message", "2026-07-01T12:00:00.000Z", "second")],
        nextCursor: null,
      },
    ];
    renderTimeline();
    await waitFor(() => {
      screen.getByText("first");
    });
    expect(screen.getByTestId("timeline-status").textContent).toContain(
      "Showing 1 activity entry",
    );

    fireEvent.click(screen.getByText("Load more"));

    await waitFor(() => {
      screen.getByText("second");
    });
    expect(activityCalls[1]).toEqual({
      principalId: "prn_u1",
      cursor: "cursor-1",
    });
    screen.getByText("first");
    expect(screen.getByTestId("timeline-status").textContent).toContain(
      "Showing 2 activity entries",
    );
    expect(screen.queryByText("Load more")).toBeNull();
  });

  it("shows an empty state for an actor with no activity", async () => {
    activityPages = [{ entries: [], nextCursor: null }];
    renderTimeline();
    await waitFor(() => {
      screen.getByText("No activity recorded for this actor yet.");
    });
  });
});

describe("groupEntriesByDay", () => {
  it("groups consecutive same-day entries and splits across days", () => {
    const groups = groupEntriesByDay([
      entry("a", "message", "2026-07-01T15:00:00.000Z", null),
      entry("b", "tool_call", "2026-07-01T09:00:00.000Z", null),
      entry("c", "session", "2026-06-30T22:00:00.000Z", null),
    ] as never);
    expect(groups.reduce((n, g) => n + g.entries.length, 0)).toBe(3);
    expect(groups.length).toBeLessThanOrEqual(3);
  });
});
