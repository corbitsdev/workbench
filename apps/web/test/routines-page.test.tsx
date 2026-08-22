// Screen-level proof for the global Routines page: every routine across
// every workbench the account belongs to, as ops rows (CL-6418) —
// human-language schedule, the scheduler's own next-run clock, health as
// a state pill with a caption, the last run and its status, workbench
// attribution, Pause/Resume, and Run now. `GlobalRoutinesList` is pure
// (real props in, honest markup out); `RoutinesRoute` (aggregation across
// bench memberships, never creator-scoped) gets its own fetch-mocked
// integration coverage below.
//
// Row detail is a page now (`/routines/<id>`), not an inline expansion,
// and the row links there by id — the only address a routine has that a
// rename cannot break.

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GlobalRoutinesList,
  nextRunLabel,
  routineRowHealth,
  scheduleSentence,
} from "../src/pages/routines-page";
import type { GlobalRoutineRow } from "../src/pages/routines-page";
import { NavigationProvider } from "../src/navigation";
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
  nextFireAt: "2026-01-02T09:00:00.000Z",
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
  onToggleEnabled: (_row: GlobalRoutineRow, _enabled: boolean) => {},
  onRunNow: (_row: GlobalRoutineRow) => Promise.resolve(),
  onOpenWorkbench: (_workbenchId: string) => {},
};

function renderList(rows: readonly GlobalRoutineRow[]): string {
  return renderToStaticMarkup(
    <NavigationProvider navigate={noop}>
      <GlobalRoutinesList rows={rows} {...listProps} />
    </NavigationProvider>,
  );
}

describe("routineRowHealth", () => {
  test("Off for a disabled routine, regardless of run history", () => {
    const health = routineRowHealth(
      row({ routine: { ...routine, enabled: false } }),
      listProps.now,
    );
    expect(health.state).toBe("off");
    expect(health.label).toBe("Off");
  });

  test("Paused for a dead-lettered routine", () => {
    const health = routineRowHealth(
      row({
        routine: { ...routine, deadLetteredAt: "2026-01-02T00:00:00.000Z" },
      }),
      listProps.now,
    );
    expect(health.state).toBe("paused");
  });

  test("a clean streak is counted, not just asserted", () => {
    const finished: RoutineRun = {
      runId: "run_1",
      triggeredBy: "schedule",
      createdAt: "2026-01-01T00:00:00.000Z",
      run: { status: "completed" },
    };
    const health = routineRowHealth(
      row({ runs: [finished, finished] }),
      listProps.now,
    );
    expect(health.state).toBe("ok");
    expect(health.cleanStreak).toBe(2);
  });
});

describe("scheduleSentence", () => {
  test("humanizes the cadence and never prints the expression", () => {
    const sentence = scheduleSentence(row());
    expect(sentence).toBe("At 09:00 (UTC)");
    expect(sentence).not.toMatch(/\d+ \d+ \* \* \*/);
  });

  test("a raw cron routine still reads as a sentence", () => {
    const sentence = scheduleSentence(
      row({
        routine: {
          ...routine,
          trigger: { kind: "cron", expression: "0 9 * * 1-5" },
        },
      }),
    );
    expect(sentence).toContain("Monday through Friday");
    expect(sentence).not.toContain("1-5");
  });

  test("a manual routine says it runs on demand", () => {
    expect(
      scheduleSentence(row({ routine: { ...routine, trigger: null } })),
    ).toBe("On demand only");
  });
});

describe("nextRunLabel", () => {
  test("reads the scheduler's own clock, not a re-derived estimate", () => {
    expect(nextRunLabel(row(), listProps.now)).toBe(
      // 2026-01-02T09:00Z from 2026-01-01T12:00Z
      "in 21h",
    );
  });

  test("a routine with nothing scheduled says so rather than guessing", () => {
    expect(
      nextRunLabel(
        row({ routine: { ...routine, trigger: null, nextFireAt: null } }),
        listProps.now,
      ),
    ).toBe("Not scheduled");
  });

  test("a disabled routine reads as paused, not as a stale countdown", () => {
    expect(
      nextRunLabel(
        row({ routine: { ...routine, enabled: false } }),
        listProps.now,
      ),
    ).toBe("Paused");
  });
});

describe("GlobalRoutinesList", () => {
  test("says there are no routines yet when the list is empty", () => {
    expect(renderList([])).toContain("No routines yet");
  });

  test("a row carries the ops columns: schedule, next run, health, last run", () => {
    const markup = renderList([
      row({
        runs: [
          {
            runId: "run_1",
            triggeredBy: "schedule",
            createdAt: "2026-01-01T09:00:00.000Z",
            run: { status: "completed" },
          },
        ],
      }),
    ]);
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Acme Team");
    expect(markup).toContain("At 09:00 (UTC)");
    expect(markup).toContain("in 21h");
    expect(markup).toContain("Healthy");
    expect(markup).toContain("Finished");
    expect(markup).toContain("Ops");
  });

  test("the routine's name links to its own page by id, not by name", () => {
    const markup = renderList([row()]);
    expect(markup).toContain('href="/routines/rtn_1"');
    expect(markup).not.toContain('href="/routines/morning-brief"');
  });

  test("a past-due next run reads as overdue, never as time already elapsed", () => {
    const markup = renderList([
      row({
        routine: { ...routine, nextFireAt: "2025-12-31T00:00:00.000Z" },
      }),
    ]);
    expect(markup).toContain("Overdue");
    expect(markup).not.toContain("ago</td>");
  });

  test("statuses and causes read as words, not as column values", () => {
    const markup = renderList([
      row({
        runs: [
          {
            runId: "run_1",
            triggeredBy: "schedule",
            createdAt: "2026-01-01T11:55:00.000Z",
            run: { status: "running" },
          },
        ],
      }),
    ]);
    expect(markup).toContain("Running now");
    expect(markup).not.toContain(">running<");
  });

  test("warm-keep (CL-6681): a fire whose 'running' status is stale reads as finished, not stuck Running now forever", () => {
    const markup = renderList([
      row({
        runs: [
          {
            runId: "run_1",
            triggeredBy: "schedule",
            createdAt: "2026-01-01T09:00:00.000Z",
            run: { status: "running" },
          },
        ],
      }),
    ]);
    expect(markup).not.toContain("Running now");
    expect(markup).toContain("Finished");
  });

  test("a failing routine states its failure count in words, not only in colour", () => {
    const markup = renderList([
      row({ routine: { ...routine, consecutiveFailures: 2 } }),
    ]);
    expect(markup).toContain("Failing");
    expect(markup).toContain("2 runs failed in a row");
  });

  test("a routine that has never run says Never rather than showing an empty cell", () => {
    expect(renderList([row()])).toContain("Never");
  });

  test("a routine with no delivery workbench shows a dash, not a broken link", () => {
    const markup = renderList([
      row({
        routine: { ...routine, deliveryWorkbenchId: null },
        deliveryWorkbenchName: null,
      }),
    ]);
    expect(markup).toContain("—");
  });

  test("Run now calls onRunNow with the row", async () => {
    const calls: GlobalRoutineRow[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(NavigationProvider, {
          navigate: noop,
          children: createElement(GlobalRoutinesList, {
            rows: [row()],
            ...listProps,
            onRunNow: (r: GlobalRoutineRow) => {
              calls.push(r);
              return Promise.resolve();
            },
          }),
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

  test("the On switch calls onToggleEnabled with the flipped value", () => {
    const calls: [GlobalRoutineRow, boolean][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(NavigationProvider, {
          navigate: noop,
          children: createElement(GlobalRoutinesList, {
            rows: [row()],
            ...listProps,
            onToggleEnabled: (r: GlobalRoutineRow, enabled: boolean) => {
              calls.push([r, enabled]);
            },
          }),
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

  test("a paused routine's action reads Resume and re-enables it", () => {
    const calls: [GlobalRoutineRow, boolean][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(NavigationProvider, {
          navigate: noop,
          children: createElement(GlobalRoutinesList, {
            rows: [row({ routine: { ...routine, enabled: false } })],
            ...listProps,
            onToggleEnabled: (r: GlobalRoutineRow, enabled: boolean) => {
              calls.push([r, enabled]);
            },
          }),
        }),
      );
    });
    try {
      const resumeButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Resume",
      );
      expect(resumeButton).not.toBeUndefined();
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "Run now",
        ),
      ).toBe(false);
      act(() => {
        resumeButton?.click();
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toBe(true);
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
        createElement(NavigationProvider, {
          navigate: noop,
          children: createElement(GlobalRoutinesList, {
            rows: [row()],
            ...listProps,
            onOpenWorkbench: (workbenchId: string) => opened.push(workbenchId),
          }),
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
});

describe("RoutinesRoute — membership-based aggregation (CL-6362)", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function routineRecord(
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      definitionId: "wfd_1",
      trigger: null,
      scope: "bench",
      input: {},
      enabled: true,
      deliveryWorkbenchId: null,
      consecutiveFailures: 0,
      deadLetteredAt: null,
      nextFireAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

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
    tnt_1: [routineRecord({ id: "rtn_mine", name: "My digest" })],
    tnt_2: [routineRecord({ id: "rtn_theirs", name: "Their digest" })],
  };

  function mockFetch(): typeof fetch {
    return (async (input: RequestInfo | URL): Promise<Response> => {
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
  }

  async function renderRoute(
    navigate: (to: string) => void,
  ): Promise<{ container: HTMLDivElement; root: Root }> {
    const { BenchProvider } = await import("../src/bench-context");
    const { CanvasAvailabilityProvider } =
      await import("../src/shell/canvas-availability");
    const { RoutinesRoute } = await import("../src/pages/routines-page");
    const { TestQueryProvider } = await import("./test-query-provider");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={navigate}>
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
                {createElement(RoutinesRoute, { navigate })}
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
    return { container, root };
  }

  test("lists routines from every bench the account is a member of, not just the currently selected one, and never creator-scoped", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mockFetch();
    const { container, root } = await renderRoute(() => {});
    try {
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

  test("each row links to its routine by id — the address a rename cannot break", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mockFetch();
    const { container, root } = await renderRoute(() => {});
    try {
      const hrefs = [...container.querySelectorAll("a")].map((a) =>
        a.getAttribute("href"),
      );
      expect(hrefs).toContain("/routines/rtn_mine");
      expect(hrefs).toContain("/routines/rtn_theirs");
      expect(hrefs).not.toContain("/routines/my-digest");
    } finally {
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = realFetch;
      window.localStorage.clear();
    }
  });
});
