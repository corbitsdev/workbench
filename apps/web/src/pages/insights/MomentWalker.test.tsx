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
let activityErrorStatus: number | undefined;
let detailResult: Record<string, unknown> = {
  kind: "workflow_run",
  id: "run_1",
};

mock.module("@workbench/client", () => ({
  getPrincipalActivity: () => {
    if (activityError) {
      const err = Object.assign(new Error("boom"), {
        ...(activityErrorStatus !== undefined
          ? { status: activityErrorStatus }
          : {}),
      });
      return Promise.reject(err);
    }
    return Promise.resolve({ entries: activityEntries, nextCursor: null });
  },
  getMomentDetail: () => Promise.resolve(detailResult),
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
  activityErrorStatus = undefined;
  detailResult = { kind: "workflow_run", id: "run_1" };
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

  it("renders a tool_call moment's REAL recorded input and output from the detail join", async () => {
    activityEntries = ENTRIES;
    detailResult = {
      kind: "tool_call",
      id: "tc_1",
      toolCall: {
        toolName: "attio__list_objects",
        input: { query: "acme corp" },
        output: "Found 3 records",
        isError: false,
      },
    };
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    const listbox = screen.getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");

    const panel = screen.getByTestId("moment-decomposition");
    // Real input arguments and output content, not a "not recorded" chip.
    await waitFor(() => within(panel).getByText(/acme corp/));
    within(panel).getByText(/Found 3 records/);
  });

  it("marks an errored tool call distinctly from a successful one", async () => {
    activityEntries = ENTRIES;
    detailResult = {
      kind: "tool_call",
      id: "tc_1",
      toolCall: {
        toolName: "attio__list_objects",
        input: { query: "acme corp" },
        output: "rate limited",
        isError: true,
      },
    };
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    const panel = screen.getByTestId("moment-decomposition");
    await waitFor(() => within(panel).getByTestId("moment-tool-errored"));
    within(panel).getByText("Errored");
  });

  it("surfaces honest attribution gaps on a tool_call moment", async () => {
    activityEntries = ENTRIES;
    detailResult = {
      kind: "tool_call",
      id: "tc_1",
      toolCall: {
        toolName: "attio__list_objects",
        input: { query: "acme corp" },
        output: "Found 3 records",
        isError: false,
      },
    };
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    const panel = screen.getByTestId("moment-decomposition");
    await waitFor(() => within(panel).getByTestId("moment-records-gap"));
    within(panel).getByTestId("moment-grant-gap");
    within(panel).getByTestId("moment-tokens-gap");
    within(panel).getByTestId("moment-cost-gap");
  });

  it("does not mark a successful tool call as errored", async () => {
    activityEntries = ENTRIES;
    detailResult = {
      kind: "tool_call",
      id: "tc_1",
      toolCall: {
        toolName: "attio__list_objects",
        input: { query: "acme corp" },
        output: "Found 3 records",
        isError: false,
      },
    };
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    const panel = screen.getByTestId("moment-decomposition");
    await waitFor(() => within(panel).getByText(/Found 3 records/));
    expect(within(panel).queryByTestId("moment-tool-errored")).toBeNull();
  });

  it("shows an honest, quiet absence when a tool call recorded no I/O", async () => {
    activityEntries = ENTRIES;
    detailResult = {
      kind: "tool_call",
      id: "tc_1",
      toolCall: {
        toolName: null,
        input: null,
        output: null,
        isError: false,
      },
    };
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    const panel = screen.getByTestId("moment-decomposition");
    await waitFor(() => within(panel).getByTestId("moment-input-empty"));
    within(panel).getByTestId("moment-output-empty");
  });

  it("surfaces a real derived duration on an inference_turn moment", async () => {
    activityEntries = [
      {
        id: "turn_1",
        kind: "inference_turn",
        sourceTable: "inference_turn",
        timestamp: "2026-07-01T12:00:00.000Z",
        summary: "deepseek-v4-flash",
      },
    ];
    detailResult = {
      kind: "inference_turn",
      id: "turn_1",
      turn: {
        model: "deepseek-v4-flash",
        durationMs: 4200,
        parts: [{ type: "text", content: "hi" }],
      },
    };
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    const panel = screen.getByTestId("moment-decomposition");
    await waitFor(() => within(panel).getByTestId("moment-duration"));
    within(panel).getByText("4.2s");
    within(panel).getByTestId("moment-turn-model");
  });

  it("shows the grant effect on a grant moment (no loud usage-gap chip)", async () => {
    activityEntries = ENTRIES;
    renderWalker();

    await waitFor(() => screen.getByRole("listbox"));
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "End" });

    const panel = screen.getByTestId("moment-decomposition");
    within(panel).getByText("Allowed");
    expect(within(panel).queryByTestId("gap-grant-usage")).toBeNull();
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

  it("renders a retryable error state when activity fails transiently", async () => {
    activityError = true;
    activityErrorStatus = 503;
    renderWalker();

    await waitFor(() => screen.getByTestId("moment-walker-error"));
    screen.getByText(/Please try again/);
    screen.getByRole("button", { name: "Retry" });
    expect(screen.queryByTestId("moment-walker-forbidden")).toBeNull();
  });

  it("renders a permission message with no retry on a 403", async () => {
    activityError = true;
    activityErrorStatus = 403;
    renderWalker();

    await waitFor(() => screen.getByTestId("moment-walker-forbidden"));
    screen.getByText(
      /You don.t have permission to view this person.s activity\./,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByTestId("moment-walker-error")).toBeNull();
  });
});
