/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    Promise.resolve({ entries: activityEntries, nextCursor: null }),
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
});
afterEach(() => cleanup());

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
    screen.getByText("User");
    screen.getByText("myra@example.com");
    // The principal id is always shown as a mono readout.
    screen.getByText("prn_u1");
  });

  it("shows a status badge for a non-active actor", async () => {
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
    expect(screen.getByTestId("actor-status").textContent).toBe("deactivated");
    screen.getByText("Agent");
  });

  it("derives quick stats from the loaded activity", async () => {
    actorResult = {
      id: "prn_u1",
      kind: "user",
      displayName: "Myra Ops",
      status: "active",
    };
    activityEntries = [
      {
        id: "m1",
        kind: "message",
        sourceTable: "message",
        timestamp: "2026-07-01T15:00:00.000Z",
        summary: "hi",
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

    await waitFor(() => {
      screen.getByText("Entries loaded");
    });
    await waitFor(() => {
      screen.getByText("2");
    });
    // Last-active derived from the newest entry, not fabricated.
    screen.getByText("Last active");
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
    screen.getByText("prn_unknown");
  });
});
