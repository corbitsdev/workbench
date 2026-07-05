/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

type TenantRoster = {
  instances: {
    instanceId: string;
    principalId: string;
    name: string;
    status: string;
    sessionCount: number;
  }[];
  runs: { runId: string; kind: string; status: string }[];
};

let rosterResult: TenantRoster | null = null;
let rosterError: Error | null = null;
let hang = false;

mock.module("@workbench/client", () => ({
  getTenantRoster: () => {
    if (hang) return new Promise<TenantRoster>(() => {});
    if (rosterError) return Promise.reject(rosterError);
    return Promise.resolve(rosterResult ?? { instances: [], runs: [] });
  },
}));

import { TenantRoster } from "./TenantRoster";

function renderRoster() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TenantRoster tenantId="tenant-1" />
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

describe("TenantRoster", () => {
  it("links each agent instance to its trace and each run to its execution trace", async () => {
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

    renderRoster();

    const instance = await screen.findByTestId("roster-instance");
    // The agent instance deep-links to its synthetic principal's OWN trace.
    expect(instance.getAttribute("href")).toBe("/insights/users/prn_syn_1");
    expect(instance.textContent).toContain("Myra");
    expect(instance.textContent).toContain("2 sessions");

    const run = screen.getByTestId("roster-run");
    expect(run.getAttribute("href")).toBe("/insights/trace/run_1");
    // The raw kind is kept as a secondary reference beside the humanized title.
    expect(run.textContent).toContain("last30days");
  });

  it("colors statuses from the shared tone vocabulary (running instance = live green; completed run = green)", async () => {
    rosterResult = {
      instances: [
        {
          instanceId: "ins_run",
          principalId: "prn_run",
          name: "Live",
          status: "running",
          sessionCount: 1,
        },
        {
          instanceId: "ins_end",
          principalId: "prn_end",
          name: "Ended",
          status: "ended",
          sessionCount: 0,
        },
      ],
      runs: [
        { runId: "run_done", kind: "brief", status: "completed" },
        { runId: "run_live", kind: "brief", status: "running" },
      ],
    };

    renderRoster();

    const instances = await screen.findAllByTestId("roster-instance");
    // A running instance is alive → the green ("positive") tone, NOT the dead
    // blue path that the old `status === "active"` check made unreachable.
    const liveChip = within(instances[0]!).getByTestId("roster-status-chip");
    expect(liveChip.className).toContain("text-green-deep");
    // An ended instance is inert → neutral, never green.
    const endedChip = within(instances[1]!).getByTestId("roster-status-chip");
    expect(endedChip.className).toContain("text-text-3");
    expect(endedChip.className).not.toContain("text-green-deep");

    const runs = screen.getAllByTestId("roster-run");
    // A completed run is green (brand completion), matching its trace header —
    // not the old local blue mapping.
    const doneChip = within(runs[0]!).getByTestId("roster-status-chip");
    expect(doneChip.className).toContain("text-green-deep");
    // A live run is in-progress blue, distinct from a completed run.
    const liveRunChip = within(runs[1]!).getByTestId("roster-status-chip");
    expect(liveRunChip.className).toContain("text-blue-deep");
  });

  it("shows a loading state before data resolves", () => {
    hang = true;
    renderRoster();
    // Two panels (agents + runs), each with its own loading rows.
    expect(screen.getAllByTestId("tenant-roster-loading").length).toBe(2);
  });

  it("shows honest empty states for both panels", async () => {
    rosterResult = { instances: [], runs: [] };
    renderRoster();
    await screen.findByText("No agent instances in this workbench yet.");
    screen.getByText("No workflow runs in this workbench yet.");
  });

  it("surfaces a legible error with a retry", async () => {
    rosterError = new Error("boom");
    renderRoster();
    await waitFor(() => screen.getByText(/Couldn.t load agents and runs/));
    screen.getByText("Retry");
  });
});
