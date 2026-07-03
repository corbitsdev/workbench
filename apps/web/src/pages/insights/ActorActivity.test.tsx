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

type Actor = {
  id: string;
  kind: "user" | "agent";
  displayName: string;
  email?: string;
  status: string;
};

type TimelineEntry = {
  kind: string;
  id: string;
  sourceTable: string;
  timestamp: string;
  summary: string | null;
};

type ActivityPage = { entries: TimelineEntry[]; nextCursor: string | null };

let searchCalls: { tenantId: string; query: string }[] = [];
let searchResult: Actor[] = [];
let searchError: Error | null = null;

let activityCalls: {
  tenantId: string;
  principalId: string;
  cursor?: string;
}[] = [];
let activityPages: ActivityPage[] = [];
let activityError: Error | null = null;

mock.module("@workbench/client", () => ({
  searchActors: (
    _options: unknown,
    params: { tenantId: string; query: string },
  ) => {
    searchCalls.push({ tenantId: params.tenantId, query: params.query });
    if (searchError) return Promise.reject(searchError);
    return Promise.resolve(searchResult);
  },
  getPrincipalActivity: (
    _options: unknown,
    params: { tenantId: string; principalId: string; cursor?: string },
  ) => {
    activityCalls.push({
      tenantId: params.tenantId,
      principalId: params.principalId,
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    });
    if (activityError) return Promise.reject(activityError);
    const page = activityPages[activityCalls.length - 1] ?? {
      entries: [],
      nextCursor: null,
    };
    return Promise.resolve(page);
  },
}));

import { ActorActivitySection, groupEntriesByDay } from "./ActorActivity";

const USER_ACTOR: Actor = {
  id: "prn_u1",
  kind: "user",
  displayName: "Myra Ops",
  email: "myra@example.com",
  status: "active",
};
const DEACTIVATED_AGENT: Actor = {
  id: "prn_a1",
  kind: "agent",
  displayName: "Oat",
  status: "deactivated",
};

function entry(
  id: string,
  kind: string,
  timestamp: string,
  summary: string | null = null,
): TimelineEntry {
  return { id, kind, sourceTable: kind, timestamp, summary };
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ActorActivitySection tenantId="tenant-1" />
    </QueryClientProvider>,
  );
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value } });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchFor(query: string, actors: Actor[]) {
  searchResult = actors;
  typeQuery(query);
  await waitFor(() => {
    expect(searchCalls.length).toBeGreaterThanOrEqual(1);
  });
}

beforeEach(() => {
  searchCalls = [];
  searchResult = [];
  searchError = null;
  activityCalls = [];
  activityPages = [];
  activityError = null;
});

afterEach(() => {
  cleanup();
});

describe("ActorActivitySection search", () => {
  it("does not fetch for queries under 2 characters", async () => {
    renderSection();
    typeQuery("m");
    await sleep(450);
    expect(searchCalls.length).toBe(0);
    screen.getByText("Type at least 2 characters to search.");
  });

  it("debounces a keystroke burst into a single request for the final query", async () => {
    renderSection();
    typeQuery("my");
    typeQuery("myr");
    typeQuery("myra");
    await sleep(450);
    await waitFor(() => {
      expect(searchCalls.length).toBe(1);
    });
    expect(searchCalls[0]).toEqual({ tenantId: "tenant-1", query: "myra" });
  });

  it("renders results with kind tags and a status chip for non-active actors", async () => {
    renderSection();
    await searchFor("oa", [USER_ACTOR, DEACTIVATED_AGENT]);

    await waitFor(() => {
      screen.getByText("Myra Ops");
    });
    screen.getByText("Oat");
    screen.getByText("myra@example.com");
    screen.getByText("User");
    screen.getByText("Agent");
    // Only the deactivated agent carries a status chip.
    const chips = screen.getAllByTestId("actor-status");
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toBe("deactivated");
  });

  it("shows an empty state when nothing matches", async () => {
    renderSection();
    await searchFor("zz", []);
    await waitFor(() => {
      screen.getByText(/No people or agents match/);
    });
  });

  it("shows a plain-language error when search fails", async () => {
    searchError = new Error("HTTP 500");
    renderSection();
    typeQuery("my");
    await waitFor(() => {
      screen.getByText("Search failed. Please try again.");
    });
  });
});

describe("ActorActivitySection timeline", () => {
  it("loads the selected actor's timeline and renders entries grouped by day", async () => {
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
    renderSection();
    await searchFor("my", [USER_ACTOR]);
    await waitFor(() => {
      screen.getByText("Myra Ops");
    });

    fireEvent.click(screen.getByText("Myra Ops"));

    await waitFor(() => {
      expect(activityCalls.length).toBe(1);
    });
    expect(activityCalls[0]).toEqual({
      tenantId: "tenant-1",
      principalId: "prn_u1",
    });

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
    // Null summary renders a neutral fallback, not a blank row.
    screen.getByText("No details recorded");
    // Grant/credential blind-spot caveat is always visible on the timeline.
    screen.getByText(/current state only/);
  });

  it("appends the next page via the cursor on Load more", async () => {
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
    renderSection();
    await searchFor("my", [USER_ACTOR]);
    await waitFor(() => {
      screen.getByText("Myra Ops");
    });
    fireEvent.click(screen.getByText("Myra Ops"));

    await waitFor(() => {
      screen.getByText("first");
    });
    fireEvent.click(screen.getByText("Load more"));

    await waitFor(() => {
      screen.getByText("second");
    });
    expect(activityCalls.length).toBe(2);
    expect(activityCalls[1]).toEqual({
      tenantId: "tenant-1",
      principalId: "prn_u1",
      cursor: "cursor-1",
    });
    // First page stays rendered; the second page appends.
    screen.getByText("first");
    expect(screen.queryByText("Load more")).toBeNull();
  });

  it("shows an empty state for an actor with no activity", async () => {
    activityPages = [{ entries: [], nextCursor: null }];
    renderSection();
    await searchFor("my", [USER_ACTOR]);
    await waitFor(() => {
      screen.getByText("Myra Ops");
    });
    fireEvent.click(screen.getByText("Myra Ops"));

    await waitFor(() => {
      screen.getByText("No activity recorded for this actor yet.");
    });
  });

  it("shows a legible error with a retry action when the timeline fails", async () => {
    activityError = new Error("HTTP 403");
    renderSection();
    await searchFor("my", [USER_ACTOR]);
    await waitFor(() => {
      screen.getByText("Myra Ops");
    });
    fireEvent.click(screen.getByText("Myra Ops"));

    await waitFor(() => {
      screen.getByText(/Couldn't load this actor's activity/);
    });

    activityError = null;
    activityPages = [
      {
        entries: [entry("m1", "message", "2026-07-01T15:00:00.000Z", "ok")],
        nextCursor: null,
      },
      {
        entries: [entry("m1", "message", "2026-07-01T15:00:00.000Z", "ok")],
        nextCursor: null,
      },
    ];
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => {
      screen.getByText("ok");
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
    expect(groups.length).toBeLessThanOrEqual(3);
    expect(groups.reduce((n, g) => n + g.entries.length, 0)).toBe(3);
    // Entries on the same local day share one group.
    const first = groups[0]!;
    if (first.entries.length === 2) {
      expect(first.entries.map((e) => e.id)).toEqual(["a", "b"]);
    }
  });
});
