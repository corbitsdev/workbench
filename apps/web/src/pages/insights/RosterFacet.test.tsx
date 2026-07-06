/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

type PrincipalRoster = {
  instances: {
    instanceId: string;
    principalId: string;
    name: string;
    status: string;
    sessionCount: number;
  }[];
  runs: { runId: string; kind: string; status: string }[];
};

let rosterResult: PrincipalRoster | null = null;
let rosterError: Error | null = null;
let hang = false;

mock.module("@workbench/client", () => ({
  getPrincipalRoster: () => {
    if (hang) return new Promise<PrincipalRoster>(() => {});
    if (rosterError) return Promise.reject(rosterError);
    return Promise.resolve(rosterResult ?? { instances: [], runs: [] });
  },
}));

import { RosterFacet } from "./principal-facets";

function renderFacet() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RosterFacet tenantId="tenant-1" principalId="prn_member" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rosterResult = null;
  rosterError = null;
  hang = false;
});
afterEach(() => cleanup());

describe("RosterFacet", () => {
  it("renders clickable cards linking each instance and run to its own trace", async () => {
    rosterResult = {
      instances: [
        {
          instanceId: "ins_1",
          principalId: "prn_syn_1",
          name: "Myra",
          status: "running",
          sessionCount: 2,
        },
      ],
      runs: [{ runId: "run_1", kind: "last30days", status: "completed" }],
    };

    renderFacet();

    const instanceLink = await screen.findByText("Myra");
    // The agent instance links to its synthetic principal's OWN trace.
    expect(instanceLink.closest("a")?.getAttribute("href")).toBe(
      "/insights/users/prn_syn_1",
    );

    const runLink = screen.getByText("last30days");
    expect(runLink.closest("a")?.getAttribute("href")).toBe(
      "/insights/trace/run_1",
    );

    // The per-instance session count is surfaced, not fabricated cost.
    screen.getByText("running · 2 sessions");
  });

  it("shows a loading state before data resolves", () => {
    hang = true;
    renderFacet();
    expect(screen.getByTestId("roster-loading")).toBeTruthy();
  });

  it("shows honest empty states for both groups", async () => {
    rosterResult = { instances: [], runs: [] };
    renderFacet();
    await screen.findByText("This principal owns no agent instances.");
    screen.getByText("This principal has started no workflow runs.");
  });

  it("surfaces a legible error with a retry", async () => {
    rosterError = new Error("boom");
    renderFacet();
    await waitFor(() =>
      screen.getByText(/Couldn.t load this principal.s agents and runs/),
    );
    screen.getByText("Retry");
  });
});
