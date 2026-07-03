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
import { MemoryRouter } from "react-router";

type TimelineEntry = {
  kind: string;
  id: string;
  sourceTable: string;
  timestamp: string;
  summary: string | null;
};

let activityEntries: TimelineEntry[] = [];
let activityError = false;

mock.module("@workbench/client", () => ({
  getPrincipalActivity: () => {
    if (activityError) return Promise.reject(new Error("boom"));
    return Promise.resolve({ entries: activityEntries, nextCursor: null });
  },
}));

const { MomentWalker } = await import("./MomentWalker");

function renderWalker() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MomentWalker tenantId="tenant-1" principalId="prn_1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Newest-first, as the hub returns.
const ENTRIES: TimelineEntry[] = [
  {
    id: "run_1",
    kind: "workflow_run",
    sourceTable: "workflow_run_record",
    timestamp: "2026-07-01T12:02:05.000Z",
    summary: "landing_page completed",
  },
  {
    id: "tc_1",
    kind: "tool_call",
    sourceTable: "analytics_event",
    timestamp: "2026-07-01T12:02:00.000Z",
    summary: "attio__list_objects",
  },
  {
    id: "g_1",
    kind: "grant",
    sourceTable: "grant",
    timestamp: "2026-07-01T12:00:00.000Z",
    summary: "tool:attio__list_objects invoke allow",
  },
];

beforeEach(() => {
  activityEntries = [];
  activityError = false;
});
afterEach(() => cleanup());

describe("MomentWalker", () => {
  it("renders each moment with a plain-language headline, not a raw token", async () => {
    activityEntries = ENTRIES;
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    // Grant is reframed as the action it allowed, not "tool:attio__list_objects invoke allow".
    within(options[2]!).getByText("Allowed: List objects");
    // Tool call is reframed as "Ran ...".
    within(options[1]!).getByText("Ran Attio list objects");
  });

  it("auto-expands the first moment and shows its compliance reference (raw id + source table)", async () => {
    activityEntries = ENTRIES;
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    const panel = screen.getByTestId("moment-decomposition");
    // Raw id and source table are shown as secondary compliance references.
    within(panel).getByText("run_1");
    within(panel).getByText("workflow_run_record");
  });

  it("cross-links a workflow_run moment to its run trace", async () => {
    activityEntries = ENTRIES;
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    const link = screen.getByRole("link", { name: "Open run trace" });
    expect(link.getAttribute("href")).toBe("/insights/trace/run_1");
  });

  it("steps to the next (older) moment on ArrowDown and expands it", async () => {
    activityEntries = ENTRIES;
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    const listbox = screen.getByRole("listbox");

    // First moment selected initially.
    expect(
      screen.getAllByRole("option")[0]!.getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(options[0]!.getAttribute("aria-selected")).toBe("false");

    // The now-selected tool_call moment surfaces its honest tool-I/O gap.
    const panel = screen.getByTestId("moment-decomposition");
    within(panel).getByTestId("gap-tool-io");
  });

  it("shows the grant effect and an honest grant-usage gap on a grant moment", async () => {
    activityEntries = ENTRIES;
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "End" });

    const panel = screen.getByTestId("moment-decomposition");
    within(panel).getByText("Allowed");
    within(panel).getByTestId("gap-grant-usage");
  });

  it("keeps the grant headline and effect badge in agreement across effects", async () => {
    // A needs-approval (ask) grant must NOT headline as "Blocked" while its
    // badge reads "Needs approval" — compliance readers must never see a
    // needs-approval grant described as denied.
    for (const [effect, label] of [
      ["allow", "Allowed"],
      ["deny", "Blocked"],
      ["ask", "Needs approval"],
    ] as const) {
      activityEntries = [
        {
          id: "g_e",
          kind: "grant",
          sourceTable: "grant",
          timestamp: "2026-07-01T12:00:00.000Z",
          summary: `tool:exa__search invoke ${effect}`,
        },
      ];
      renderWalker();
      await waitFor(() => screen.getByRole("listbox"));
      const panel = screen.getByTestId("moment-decomposition");
      within(panel).getByText(`${label}: Search`);
      within(panel).getByText(label);
      if (effect === "ask") {
        expect(within(panel).queryByText("Blocked: Search")).toBeNull();
      }
      cleanup();
    }
  });

  it("moves aria-selected to the next moment on step-through (scroll wiring)", async () => {
    activityEntries = ENTRIES;
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "End" });
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]!.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(options[0]!.getAttribute("aria-selected")).toBe("false");
  });

  it("renders an empty state when the principal has no activity", async () => {
    activityEntries = [];
    renderWalker();

    await waitFor(() => screen.getByTestId("moment-walker-empty"));
  });

  it("renders an error state when activity cannot be loaded", async () => {
    activityError = true;
    renderWalker();

    await waitFor(() => screen.getByTestId("moment-walker-error"));
  });
});
