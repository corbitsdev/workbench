// Screen-level proof for the global Routines page (CL-6362): every
// routine across every workbench the account belongs to, as rows —
// workbench attribution, running-or-not state, schedule, inline
// enable/disable, Run now, and an inline-expandable detail with recent
// runs. `GlobalRoutinesList` is pure (real props in, honest markup out);
// `RoutinesRoute` (aggregation across bench memberships, never
// creator-scoped) gets its own fetch-mocked integration coverage below.

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GlobalRoutinesList,
  routineStateChip,
  scheduleSummary,
} from "../src/pages/routines-page";
import type { GlobalRoutineRow } from "../src/pages/routines-page";
import type { Routine, RoutineRun } from "../src/routines-api";

const noop = () => undefined;

const routine: Routine = {
  id: "rtn_1",
  name: "Morning brief",
  definitionId: "wfd_1",
  trigger: { kind: "daily", hour: 9, minute: 0 },
  scope: "bench",
  input: {},
  enabled: true,
  deliveryWorkbenchId: "ch_1",
  consecutiveFailures: 0,
  deadLetteredAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function row(overrides: Partial<GlobalRoutineRow> = {}): GlobalRoutineRow {
  return {
    routine,
    tenantId: "tnt_1",
    tenantName: "Acme Team",
    deliveryWorkbenchName: "Ops",
    runs: [],
    ...overrides,
  };
}

const listProps = {
  now: Date.parse("2026-01-01T12:00:00.000Z"),
  expandedId: null as string | null,
  onToggleExpanded: noop,
  onToggleEnabled: (_row: GlobalRoutineRow, _enabled: boolean) => {},
  onRunNow: (_row: GlobalRoutineRow) => Promise.resolve(),
  onEdit: (_row: GlobalRoutineRow) => {},
  onOpenWorkbench: (_workbenchId: string) => {},
};

describe("routineStateChip", () => {
  test("Off for a disabled routine, regardless of run history", () => {
    expect(
      routineStateChip(row({ routine: { ...routine, enabled: false } })),
    ).toEqual({ label: "Off", tone: "neutral" });
  });

  test("Paused for a dead-lettered routine", () => {
    expect(
      routineStateChip(
        row({
          routine: {
            ...routine,
            deadLetteredAt: "2026-01-02T00:00:00.000Z",
          },
        }),
      ),
    ).toEqual({ label: "Paused", tone: "danger" });
  });

  test("Idle for an enabled routine with no run history", () => {
    expect(routineStateChip(row())).toEqual({ label: "Idle", tone: "neutral" });
  });

  test("Running now while the latest run is in flight", () => {
    const run: RoutineRun = {
      runId: "run_1",
      triggeredBy: "schedule",
      createdAt: "2026-01-01T00:00:00.000Z",
      run: { status: "running" },
    };
    expect(routineStateChip(row({ runs: [run] }))).toEqual({
      label: "Running now",
      tone: "success",
    });
  });

  test("Last run failed when the latest run errored", () => {
    const run: RoutineRun = {
      runId: "run_1",
      triggeredBy: "schedule-failed",
      createdAt: "2026-01-01T00:00:00.000Z",
      error: "sidecar unreachable",
    };
    expect(routineStateChip(row({ runs: [run] }))).toEqual({
      label: "Last run failed",
      tone: "danger",
    });
  });
});

describe("scheduleSummary", () => {
  test("humanizes the cadence and appends a relative next-run", () => {
    const summary = scheduleSummary(
      row(),
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
    expect(summary).toContain("Daily at 09:00 UTC");
    expect(summary).toContain("next");
    expect(summary).not.toMatch(/\d+ \d+ \* \* \*/);
  });

  test("no next-run suffix for a manual routine", () => {
    const summary = scheduleSummary(
      row({ routine: { ...routine, trigger: null } }),
      Date.now(),
    );
    expect(summary).toBe("Manual");
  });
});

describe("GlobalRoutinesList", () => {
  test("says there are no routines yet when the list is empty", () => {
    const markup = renderToStaticMarkup(
      <GlobalRoutinesList rows={[]} {...listProps} />,
    );
    expect(markup).toContain("No routines yet");
  });

  test("renders a row with its name and workbench attribution", () => {
    const markup = renderToStaticMarkup(
      <GlobalRoutinesList rows={[row()]} {...listProps} />,
    );
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Acme Team");
    expect(markup).toContain("Ops");
    expect(markup).toContain("Daily at 09:00 UTC");
  });

  test("a routine with no delivery workbench shows a dash, not a broken link", () => {
    const markup = renderToStaticMarkup(
      <GlobalRoutinesList
        rows={[
          row({
            routine: { ...routine, deliveryWorkbenchId: null },
            deliveryWorkbenchName: null,
          }),
        ]}
        {...listProps}
      />,
    );
    expect(markup).toContain("—");
  });

  test("Run now calls onRunNow with the row", async () => {
    const calls: GlobalRoutineRow[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(GlobalRoutinesList, {
          rows: [row()],
          ...listProps,
          onRunNow: (r: GlobalRoutineRow) => {
            calls.push(r);
            return Promise.resolve();
          },
        }),
      );
    });
    try {
      const runButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Run now",
      );
      expect(runButton).not.toBeUndefined();
      act(() => {
        runButton?.click();
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.routine.id).toBe("rtn_1");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("the Enabled switch calls onToggleEnabled with the flipped value", () => {
    const calls: [GlobalRoutineRow, boolean][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(GlobalRoutinesList, {
          rows: [row()],
          ...listProps,
          onToggleEnabled: (r: GlobalRoutineRow, enabled: boolean) => {
            calls.push([r, enabled]);
          },
        }),
      );
    });
    try {
      const toggle = container.querySelector('button[role="switch"]');
      expect(toggle).not.toBeNull();
      act(() => {
        (toggle as HTMLButtonElement).click();
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("clicking the delivery workbench opens it", () => {
    const opened: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(GlobalRoutinesList, {
          rows: [row()],
          ...listProps,
          onOpenWorkbench: (workbenchId: string) => opened.push(workbenchId),
        }),
      );
    });
    try {
      const link = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Ops",
      );
      expect(link).not.toBeUndefined();
      act(() => {
        link?.click();
      });
      expect(opened).toEqual(["ch_1"]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("Edit calls onEdit with the row", () => {
    const edited: GlobalRoutineRow[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(GlobalRoutinesList, {
          rows: [row()],
          ...listProps,
          onEdit: (r: GlobalRoutineRow) => edited.push(r),
        }),
      );
    });
    try {
      const editButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Edit",
      );
      expect(editButton).not.toBeUndefined();
      act(() => {
        editButton?.click();
      });
      expect(edited).toHaveLength(1);
      expect(edited[0]?.routine.id).toBe("rtn_1");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("expanding a row shows recent runs and the delivery note inline, without navigating", () => {
    const run: RoutineRun = {
      runId: "run_1",
      triggeredBy: "schedule",
      createdAt: "2026-01-01T00:00:00.000Z",
      run: { status: "completed" },
    };
    const markup = renderToStaticMarkup(
      <GlobalRoutinesList
        rows={[row({ runs: [run] })]}
        {...listProps}
        expandedId="rtn_1"
      />,
    );
    expect(markup).toContain("Run updates post into Ops");
    expect(markup).toContain("completed");
  });

  test("a collapsed row shows no run detail", () => {
    const run: RoutineRun = {
      runId: "run_1",
      triggeredBy: "schedule",
      createdAt: "2026-01-01T00:00:00.000Z",
      run: { status: "completed" },
    };
    const markup = renderToStaticMarkup(
      <GlobalRoutinesList rows={[row({ runs: [run] })]} {...listProps} />,
    );
    expect(markup).not.toContain("Run updates post into");
  });

  test("expand toggling calls onToggleExpanded with the routine id", () => {
    const toggled: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(GlobalRoutinesList, {
          rows: [row()],
          ...listProps,
          onToggleExpanded: (id: string) => toggled.push(id),
        }),
      );
    });
    try {
      const expandButton = container.querySelector("button[aria-expanded]");
      expect(expandButton).not.toBeNull();
      act(() => {
        (expandButton as HTMLButtonElement).click();
      });
      expect(toggled).toEqual(["rtn_1"]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("RoutinesRoute — membership-based aggregation (CL-6362)", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  test("lists routines from every bench the account is a member of, not just the currently selected one, and never creator-scoped", async () => {
    const { BenchProvider } = await import("../src/bench-context");
    const { NavigationProvider } = await import("../src/navigation");
    const { CanvasAvailabilityProvider } =
      await import("../src/shell/canvas-availability");
    const { RoutinesRoute } = await import("../src/pages/routines-page");
    const { TestQueryProvider } = await import("./test-query-provider");

    const realFetch = globalThis.fetch;
    // Two benches this account belongs to — GET /routines is already
    // tenant-scoped, never filtered by who created a row, so a second
    // member's routine (created by a different principal) shows up here
    // exactly like the viewer's own.
    const memberships = [
      {
        principalId: "prn_me",
        tenantId: "tnt_1",
        tenantName: "Acme Team",
        tenantSlug: "acme",
        kind: "user",
        status: "active",
        roles: [],
      },
      {
        principalId: "prn_me_2",
        tenantId: "tnt_2",
        tenantName: "Beta Team",
        tenantSlug: "beta",
        kind: "user",
        status: "active",
        roles: [],
      },
    ];
    const routinesByTenant: Record<string, Record<string, unknown>[]> = {
      tnt_1: [
        {
          id: "rtn_mine",
          name: "My digest",
          definitionId: "wfd_1",
          trigger: null,
          scope: "bench",
          input: {},
          enabled: true,
          deliveryWorkbenchId: null,
          consecutiveFailures: 0,
          deadLetteredAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      tnt_2: [
        {
          id: "rtn_theirs",
          name: "Their digest",
          definitionId: "wfd_2",
          trigger: null,
          scope: "bench",
          input: {},
          enabled: true,
          deliveryWorkbenchId: null,
          consecutiveFailures: 0,
          deadLetteredAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/me/principals")) {
        return jsonResponse({ data: memberships, nextCursor: null });
      }
      if (url.includes("/api/workbench-tenancies/kinds")) {
        return jsonResponse({ workbenchTenantIds: [] });
      }
      const routinesMatch = url.match(/\/api\/tenants\/([^/]+)\/routines$/);
      if (routinesMatch) {
        return jsonResponse({
          items: routinesByTenant[routinesMatch[1] as string] ?? [],
        });
      }
      if (url.includes("/routines/") && url.endsWith("/runs")) {
        return jsonResponse({ items: [], nextCursor: null });
      }
      if (url.includes("/chat/workbenches") && url.includes("kind=workbench")) {
        return jsonResponse({ items: [] });
      }
      return Promise.reject(new Error(`unrouted fetch: ${url}`));
    }) as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <TestQueryProvider>
            <NavigationProvider navigate={() => {}}>
              <BenchProvider>
                <CanvasAvailabilityProvider
                  allowed={false}
                  open={false}
                  profile={null}
                  artifact={null}
                  routine={null}
                  focus={false}
                  openProfile={() => {}}
                  openArtifact={() => {}}
                  openRoutine={() => {}}
                  toggleFocus={() => {}}
                  close={() => {}}
                >
                  {createElement(RoutinesRoute, {
                    path: "/routines",
                    navigate: () => {},
                  })}
                </CanvasAvailabilityProvider>
              </BenchProvider>
            </NavigationProvider>
          </TestQueryProvider>,
        );
      });
      for (let i = 0; i < 8; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }

      // Bench switcher defaults to the first bench (tnt_1) — proving the
      // second bench's routine still renders proves this page never
      // narrows to just the selected tenant.
      expect(container.textContent).toContain("My digest");
      expect(container.textContent).toContain("Their digest");
      expect(container.textContent).toContain("Acme Team");
      expect(container.textContent).toContain("Beta Team");
    } finally {
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = realFetch;
      window.localStorage.clear();
    }
  });
});
