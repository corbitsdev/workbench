/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";

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

let actorResult: Actor | null = null;
let actorCalls: string[] = [];
let activityEntries: TimelineEntry[] = [];
let activityError: Error | null = null;

mock.module("../../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({
    activeTenantId: "tenant-1",
    loading: false,
    activeWorkbench: { id: "p1", tenantId: "tenant-1", tenantName: "Acme" },
    workbenches: [],
    setActiveWorkbench: () => {},
  }),
}));

mock.module("@workbench/client", () => ({
  getActor: (_options: unknown, params: { principalId: string }) => {
    actorCalls.push(params.principalId);
    return Promise.resolve(actorResult);
  },
  getPrincipalActivity: () =>
    activityError
      ? Promise.reject(activityError)
      : Promise.resolve({ entries: activityEntries, nextCursor: null }),
  getPrincipalRoster: () => Promise.resolve({ instances: [], runs: [] }),
}));

import { ActorDetailPage } from "./ActorDetailPage";

function renderAt(id: string, state?: unknown) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[
          { pathname: `/insights/users/${id}`, state: state ?? null },
        ]}
      >
        <Routes>
          <Route path="/insights/users/:id" element={<ActorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  actorResult = null;
  actorCalls = [];
  activityEntries = [];
  activityError = null;
});
afterEach(() => cleanup());

const GRANT_ENTRY: TimelineEntry = {
  id: "g1",
  kind: "grant",
  sourceTable: "grant",
  timestamp: "2026-07-01T15:00:00.000Z",
  summary: "tool:attio__list_objects invoke ask",
};

describe("ActorDetailPage", () => {
  it("renders the actor identity from the id alone (deep link, no router state)", async () => {
    actorResult = {
      id: "prn_u1",
      kind: "user",
      displayName: "Myra Ops",
      email: "myra@example.com",
      status: "active",
    };
    renderAt("prn_u1");

    await waitFor(() => {
      screen.getByRole("heading", { name: "Myra Ops" });
    });
    expect(actorCalls).toContain("prn_u1");
    // A user principal is chipped as "principal" (rail + header), never a raw
    // kind token as the headline.
    expect(screen.getAllByText("principal").length).toBeGreaterThanOrEqual(1);
    // The principal id is shown only as a secondary mono readout.
    expect(screen.getAllByText("prn_u1").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the account status in the header pill for a non-active actor", async () => {
    actorResult = {
      id: "prn_a1",
      kind: "agent",
      displayName: "Oat",
      status: "deactivated",
    };
    renderAt("prn_a1");

    await waitFor(() => {
      screen.getByRole("heading", { name: "Oat" });
    });
    expect(screen.getByTestId("trace-status-pill").textContent).toContain(
      "deactivated",
    );
    // An agent principal is chipped "agent".
    expect(screen.getAllByText("agent").length).toBeGreaterThanOrEqual(1);
  });

  it("derives the stat strip from the loaded activity, not fabricated numbers", async () => {
    actorResult = {
      id: "prn_u1",
      kind: "user",
      displayName: "Myra Ops",
      status: "active",
    };
    activityEntries = [
      {
        id: "tc1",
        kind: "tool_call",
        sourceTable: "analytics_event",
        timestamp: "2026-07-01T15:00:00.000Z",
        summary: "attio__list_objects",
      },
      {
        id: "m2",
        kind: "message",
        sourceTable: "message",
        timestamp: "2026-06-30T15:00:00.000Z",
        summary: "yo",
      },
    ];
    renderAt("prn_u1");

    const strip = await waitFor(() => screen.getByTestId("trace-stat-strip"));
    await waitFor(() => within(strip).getByText("Moments"));
    // Two loaded moments, one of them a tool call — both derived, not faked.
    await waitFor(() => within(strip).getByText("2"));
    within(strip).getByText("Tool calls");
    within(strip).getByText("Last active");
  });

  it("defaults to the Timeline facet (moment-walker) and switches to the Grants facet", async () => {
    actorResult = {
      id: "prn_u1",
      kind: "user",
      displayName: "Myra Ops",
      status: "active",
    };
    activityEntries = [GRANT_ENTRY];
    renderAt("prn_u1");

    // Timeline is the default facet — the moment-walker listbox is shown.
    await waitFor(() => screen.getByRole("listbox"));

    fireEvent.click(screen.getByRole("tab", { name: /Grants/ }));
    await waitFor(() => screen.getByTestId("facet-grants"));
    // Facet switched away from the timeline.
    expect(screen.queryByRole("listbox")).toBeNull();
    // A needs-approval grant reads as "Needs approval", never "Blocked".
    screen.getByText("Needs approval");
    // Grant usage is an honest gap, never a fabricated count.
    expect(screen.getAllByTestId("grant-used-gap").length).toBe(1);
  });

  it("steps facets forward with the Next-step action", async () => {
    actorResult = {
      id: "prn_u1",
      kind: "user",
      displayName: "Myra Ops",
      status: "active",
    };
    activityEntries = [GRANT_ENTRY];
    renderAt("prn_u1");

    await waitFor(() => screen.getByRole("listbox"));
    // Next steps from Timeline (01) → Agents & workflows (02) → Grants (03).
    fireEvent.click(screen.getByRole("button", { name: /Next step/ }));
    await waitFor(() => screen.getByTestId("facet-roster"));
    fireEvent.click(screen.getByRole("button", { name: /Next step/ }));
    await waitFor(() => screen.getByTestId("facet-grants"));
    expect(
      screen.getByRole("tab", { name: /Grants/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("trusts router-state identity when its id matches the route principal", async () => {
    // Fetch resolves to null; the matching state actor should render instantly.
    actorResult = null;
    renderAt("prn_match", {
      id: "prn_match",
      kind: "agent",
      displayName: "Oat",
      status: "active",
    });

    await waitFor(() => {
      screen.getByRole("heading", { name: "Oat" });
    });
  });

  it("ignores a router-state actor whose id does not match the route principal (anti-spoof)", async () => {
    // A spoofed navigation payload for a DIFFERENT principal must not be
    // trusted for header identity; the page fetches by the route id instead.
    actorResult = null;
    renderAt("prn_real", {
      id: "prn_other",
      kind: "user",
      displayName: "Spoofed Name",
      status: "active",
    });

    await waitFor(() => {
      screen.getByRole("heading", { name: "Unknown actor" });
    });
    expect(screen.queryByText("Spoofed Name")).toBeNull();
    expect(actorCalls).toContain("prn_real");
  });

  it("still renders the timeline when identity lookup fails, without faking a name", async () => {
    actorResult = null;
    renderAt("prn_unknown");

    await waitFor(() => {
      screen.getByRole("heading", { name: "Unknown actor" });
    });
    expect(screen.getAllByText("prn_unknown").length).toBeGreaterThanOrEqual(1);
  });

  it("renders NO status pill when identity can't be loaded (never a fake green Active)", async () => {
    // When the principal identity is unknown, asserting a live "Active" state is
    // a fabrication — the pill must be absent, not green.
    actorResult = null;
    renderAt("prn_unknown");

    await waitFor(() => {
      screen.getByRole("heading", { name: "Unknown actor" });
    });
    expect(screen.queryByTestId("trace-status-pill")).toBeNull();
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("shows '—' (not a fabricated 0) in the stat strip when activity fails to load", async () => {
    actorResult = {
      id: "prn_u1",
      kind: "user",
      displayName: "Myra Ops",
      status: "active",
    };
    activityError = new Error("activity load failed");
    renderAt("prn_u1");

    const strip = await waitFor(() => screen.getByTestId("trace-stat-strip"));
    await waitFor(() => within(strip).getByText("Moments"));
    // Counts are unknown on error — shown as "—", never as a "0" that reads as
    // "no activity".
    expect(within(strip).getAllByText("—").length).toBeGreaterThanOrEqual(1);
    expect(within(strip).queryByText("0")).toBeNull();
  });

  it("aggregates repeated tool calls on the Tools facet from the real union", async () => {
    actorResult = {
      id: "prn_u1",
      kind: "user",
      displayName: "Myra Ops",
      status: "active",
    };
    activityEntries = [
      {
        id: "tc1",
        kind: "tool_call",
        sourceTable: "analytics_event",
        timestamp: "2026-07-01T15:00:02.000Z",
        summary: "attio__list_objects",
      },
      {
        id: "tc2",
        kind: "tool_call",
        sourceTable: "analytics_event",
        timestamp: "2026-07-01T15:00:01.000Z",
        summary: "attio__list_objects",
      },
    ];
    renderAt("prn_u1");

    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.click(screen.getByRole("tab", { name: /Tools/ }));
    const facet = await waitFor(() => screen.getByTestId("facet-tools"));
    // Two calls of one tool collapse into a single row with a call count of 2.
    within(facet).getByText("Attio list objects");
    within(facet).getByText("2");
    // The concrete records touched are an honest gap, never invented.
    within(facet).getByText("which records?");
  });

  it("cross-links a workflow_run to its own trace on the Connections facet", async () => {
    actorResult = {
      id: "prn_u1",
      kind: "user",
      displayName: "Myra Ops",
      status: "active",
    };
    activityEntries = [
      {
        id: "run_9",
        kind: "workflow_run",
        sourceTable: "workflow_run_record",
        timestamp: "2026-07-01T15:00:00.000Z",
        summary: "ab-compare-hitl",
      },
    ];
    renderAt("prn_u1");

    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.click(screen.getByRole("tab", { name: /Connections/ }));
    const node = await waitFor(() => screen.getByTestId("connection-node"));
    expect(node.getAttribute("href")).toBe("/insights/trace/run_9");
  });

  it("steps facets with the Right arrow key", async () => {
    actorResult = {
      id: "prn_u1",
      kind: "user",
      displayName: "Myra Ops",
      status: "active",
    };
    activityEntries = [GRANT_ENTRY];
    renderAt("prn_u1");

    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => screen.getByTestId("facet-roster"));
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => screen.getByTestId("facet-grants"));
  });
});
