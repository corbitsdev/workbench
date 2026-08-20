// `/routines/<id>` (CL-6418): the routine's own page — schedule as a
// sentence with the raw cron editable behind it, the target workflow with
// a way through to its steps, the whole fire history deep-linking into the
// run surface, and a health rail off telemetry the scheduler already
// records. Lifecycle actions (Run now, Pause/Resume) sit in the top bar's
// action slot and are wired to the routines package's existing mutations —
// never a button that does nothing.
//
// The address is the id; a name resolves onto it. `resolveRoutineSegment`
// is where that lives, and every one of its branches — found, redirect,
// two routines with one name, and nothing at all — is covered below,
// because those are the branches a person actually arrives through.

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { NavigationProvider } from "../src/navigation";
import {
  resolveRoutineSegment,
  RoutineDetailPage,
  RoutineScheduleSection,
} from "../src/pages/routine-detail-page";
import type { GlobalRoutineRow } from "../src/global-routines";
import type { Routine, RoutineRun } from "../src/routines-api";

const noop = () => undefined;
const NOW = Date.parse("2026-01-02T00:00:00.000Z");

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

const completedRun: RoutineRun = {
  runId: "run_1",
  triggeredBy: "schedule",
  createdAt: "2026-01-01T09:00:00.000Z",
  run: {
    status: "completed",
    createdAt: "2026-01-01T09:00:00.000Z",
    endedAt: "2026-01-01T09:00:30.000Z",
  },
};

const failedFire: RoutineRun = {
  runId: "run_0",
  triggeredBy: "schedule-failed",
  createdAt: "2025-12-31T09:00:00.000Z",
  error: "sidecar unreachable",
};

function row(overrides: Partial<GlobalRoutineRow> = {}): GlobalRoutineRow {
  return {
    routine,
    tenantId: "tnt_1",
    tenantName: "Acme Team",
    deliveryWorkbenchName: "Ops",
    runs: [completedRun],
    ...overrides,
  };
}

const pageProps = {
  now: NOW,
  workflowName: "Daily digest",
  onRunNow: () => Promise.resolve(),
  onToggleEnabled: (_enabled: boolean) => {},
  onSaveSchedule: (_expression: string) => Promise.resolve(),
};

function renderPage(overrides: Partial<GlobalRoutineRow> = {}): string {
  return renderToStaticMarkup(
    <NavigationProvider navigate={noop}>
      <RoutineDetailPage row={row(overrides)} {...pageProps} />
    </NavigationProvider>,
  );
}

describe("RoutineDetailPage", () => {
  test("titles itself with a trail back to the roster", () => {
    const markup = renderPage();
    expect(markup).toContain('href="/routines"');
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Acme Team");
  });

  test("the schedule reads as a sentence with the raw cron editable behind it", () => {
    const markup = renderPage();
    expect(markup).toContain("At 09:00 (UTC)");
    expect(markup).toContain("Cron expression");
    expect(markup).toContain('value="0 9 * * *"');
  });

  test("shows the target workflow, never an agent it runs as", () => {
    const markup = renderPage();
    expect(markup).toContain("Runs this workflow");
    expect(markup).toContain("Daily digest");
    expect(markup).not.toContain("Runs as");
  });

  test("View steps links into the run surface for the latest real run", () => {
    expect(renderPage()).toContain('href="/insights/runs/run_1"');
  });

  test("with no runs there is no steps link at all, rather than a dead one", () => {
    const markup = renderPage({ runs: [] });
    expect(markup).not.toContain("View steps");
    expect(markup).toContain("after the first run");
  });

  test("run history lists each fire and deep-links its trace", () => {
    const markup = renderPage({ runs: [completedRun, failedFire] });
    expect(markup).toContain("Run history");
    expect(markup).toContain('href="/insights/runs/run_1"');
    expect(markup).toContain("Failed to start");
    expect(markup).toContain("sidecar unreachable");
    // A fire that never produced a run has no trace to link to.
    expect(markup).not.toContain('href="/insights/runs/run_0"');
    expect(markup).toContain("Never started");
  });

  test("the health rail reports streak, typical duration, and the last failure", () => {
    const markup = renderPage({ runs: [completedRun, failedFire] });
    expect(markup).toContain("Clean streak");
    expect(markup).toContain("1 run without a failure");
    expect(markup).toContain("Typical run");
    expect(markup).toContain("30s");
    expect(markup).toContain("Last failure");
    expect(markup).toContain("sidecar unreachable");
  });

  test("last run reads off the fire history, so a run-now-only routine never says Never beside its own runs", () => {
    // `lastFireAt` is written only on a scheduled claim; a manual run
    // still shows up here, because both surfaces read the newest history
    // row instead.
    const markup = renderPage({
      routine: { ...routine, trigger: null, nextFireAt: null },
      runs: [{ ...completedRun, triggeredBy: "manual" }],
    });
    expect(markup).toContain("Last run");
    expect(markup).not.toContain("Never");
    expect(markup).toContain("By hand");
  });

  test("an enabled routine offers Pause; a disabled one offers Resume", () => {
    expect(renderPage()).toContain("Pause");
    expect(renderPage({ routine: { ...routine, enabled: false } })).toContain(
      "Resume",
    );
  });

  test("Run now and Pause both sit in the top bar's action slot", () => {
    const markup = renderPage();
    const actions = markup.slice(
      markup.indexOf('data-testid="stage-top-bar-actions"'),
    );
    expect(actions).toContain("Run now");
    expect(actions).toContain("Pause");
  });
});

describe("RoutineDetailPage lifecycle actions", () => {
  function mount(
    props: Partial<typeof pageProps> = {},
    overrides: Partial<GlobalRoutineRow> = {},
  ): { container: HTMLDivElement; root: Root } {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(NavigationProvider, {
          navigate: noop,
          children: createElement(RoutineDetailPage, {
            row: row(overrides),
            ...pageProps,
            ...props,
          }),
        }),
      );
    });
    return { container, root };
  }

  function clickButton(container: HTMLElement, label: string): void {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(button).not.toBeUndefined();
    act(() => {
      button?.click();
    });
  }

  test("Pause asks for the routine to be disabled", () => {
    const calls: boolean[] = [];
    const { container, root } = mount({
      onToggleEnabled: (enabled: boolean) => calls.push(enabled),
    });
    try {
      clickButton(container, "Pause");
      expect(calls).toEqual([false]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("Resume asks for a paused routine to be enabled again", () => {
    const calls: boolean[] = [];
    const { container, root } = mount(
      { onToggleEnabled: (enabled: boolean) => calls.push(enabled) },
      { routine: { ...routine, enabled: false } },
    );
    try {
      clickButton(container, "Resume");
      expect(calls).toEqual([true]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("Run now triggers the run-now mutation", () => {
    let runs = 0;
    const { container, root } = mount({
      onRunNow: () => {
        runs += 1;
        return Promise.resolve();
      },
    });
    try {
      clickButton(container, "Run now");
      expect(runs).toBe(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("RoutineScheduleSection", () => {
  function mount(onSave: (expression: string) => Promise<void>): {
    container: HTMLDivElement;
    root: Root;
  } {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(RoutineScheduleSection, { row: row(), onSave }),
      );
    });
    return { container, root };
  }

  function type(container: HTMLElement, value: string): void {
    const input = container.querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setter === undefined) {
      throw new Error("native value setter unavailable");
    }
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function saveButton(container: HTMLElement): HTMLButtonElement {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Save schedule",
    );
    expect(button).not.toBeUndefined();
    return button as HTMLButtonElement;
  }

  test("an unchanged schedule cannot be saved", () => {
    const { container, root } = mount(() => Promise.resolve());
    try {
      expect(saveButton(container).disabled).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("editing the expression previews what it means in words", () => {
    const { container, root } = mount(() => Promise.resolve());
    try {
      type(container, "0 9 * * 1-5");
      expect(container.textContent).toContain("Monday through Friday");
      expect(saveButton(container).disabled).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("an expression the scheduler cannot run says so and cannot be saved", () => {
    const { container, root } = mount(() => Promise.resolve());
    try {
      type(container, "99 9 * * *");
      expect(container.textContent).toContain("isn't a schedule this can run");
      expect(saveButton(container).disabled).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("saving hands the new expression up", () => {
    const saved: string[] = [];
    const { container, root } = mount((expression) => {
      saved.push(expression);
      return Promise.resolve();
    });
    try {
      type(container, "30 6 * * *");
      act(() => {
        saveButton(container).click();
      });
      expect(saved).toEqual(["30 6 * * *"]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a manual routine gets no cron field rather than an inert one", () => {
    const markup = renderToStaticMarkup(
      <RoutineScheduleSection
        row={row({ routine: { ...routine, trigger: null, nextFireAt: null } })}
        onSave={() => Promise.resolve()}
      />,
    );
    expect(markup).toContain("On demand only");
    expect(markup).not.toContain("Cron expression");
  });

  test("trailing whitespace is not a change, and does not block Save either way", () => {
    const { container, root } = mount(() => Promise.resolve());
    try {
      type(container, "0 9 * * *  ");
      expect(saveButton(container).disabled).toBe(true);
      type(container, "  30 9 * * *  ");
      expect(saveButton(container).disabled).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a valid-but-undescribable expression cannot be saved either", () => {
    // Validity and describability are the same question — "will this do
    // what it reads like?" — so an enabled Save under error copy would be
    // a lie about what is about to happen.
    const { container, root } = mount(() => Promise.resolve());
    try {
      type(container, "0 9 30 2 *");
      const enabled = !saveButton(container).disabled;
      const readable = !container.textContent?.includes(
        "isn't a schedule this can run",
      );
      expect(enabled).toBe(readable);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a refused save says so next to the field and keeps the draft", async () => {
    const { container, root } = mount(() => Promise.reject(new Error("nope")));
    try {
      type(container, "30 6 * * *");
      await act(async () => {
        saveButton(container).click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Not saved");
      const input = container.querySelector("input") as HTMLInputElement;
      expect(input.value).toBe("30 6 * * *");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("resolveRoutineSegment", () => {
  const mine = row();
  const theirs = row({
    routine: { ...routine, id: "rtn_2", name: "Morning brief" },
    tenantName: "Beta Team",
  });

  test("an id renders the page directly — no redirect hop", () => {
    expect(resolveRoutineSegment([mine], "rtn_1")).toEqual({
      kind: "found",
      row: mine,
    });
  });

  test("a name redirects to the id, so the durable address is what sticks", () => {
    expect(resolveRoutineSegment([mine], "morning-brief")).toEqual({
      kind: "redirect",
      to: "/routines/rtn_1",
    });
  });

  test("a name two routines answer to resolves to neither", () => {
    const resolution = resolveRoutineSegment([mine, theirs], "morning-brief");
    expect(resolution.kind).toBe("ambiguous");
    expect(
      resolution.kind === "ambiguous"
        ? resolution.rows.map((r) => r.routine.id)
        : [],
    ).toEqual(["rtn_1", "rtn_2"]);
  });

  test("an unknown id or name is gone, not a silent roster", () => {
    expect(resolveRoutineSegment([mine], "rtn_nope").kind).toBe("gone");
    expect(resolveRoutineSegment([mine], "no-such-routine").kind).toBe("gone");
  });

  test("an id is preferred over a name that happens to match another routine", () => {
    // A routine literally named "rtn_2" must not shadow the routine whose
    // id is `rtn_2`: the canonical address wins.
    const named = row({
      routine: { ...routine, id: "rtn_9", name: "rtn 2" },
    });
    expect(resolveRoutineSegment([named, theirs], "rtn_2")).toEqual({
      kind: "found",
      row: theirs,
    });
  });
});

describe("RoutineDetailRoute", () => {
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

  function mockFetch(
    routinesByTenant: Record<string, Record<string, unknown>[]>,
  ): typeof fetch {
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
      if (url.includes("/workflows/definitions")) {
        return jsonResponse({ data: [], nextCursor: null });
      }
      return Promise.reject(new Error(`unrouted fetch: ${url}`));
    }) as typeof fetch;
  }

  async function renderRoute(
    segment: string,
    routinesByTenant: Record<string, Record<string, unknown>[]>,
    navigate: (to: string) => void,
  ): Promise<{ container: HTMLDivElement; root: Root }> {
    const { BenchProvider } = await import("../src/bench-context");
    const { RoutineDetailRoute } =
      await import("../src/pages/routine-detail-page");
    const { TestQueryProvider } = await import("./test-query-provider");

    globalThis.fetch = mockFetch(routinesByTenant);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={navigate}>
            <BenchProvider>
              {createElement(RoutineDetailRoute, { segment, navigate })}
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

  const realFetch = globalThis.fetch;

  function cleanup(container: HTMLDivElement, root: Root): void {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
    window.localStorage.clear();
  }

  test("an id renders the routine itself, with no redirect", async () => {
    const navigated: string[] = [];
    const { container, root } = await renderRoute(
      "rtn_mine",
      { tnt_1: [routineRecord({ id: "rtn_mine", name: "My digest" })] },
      (to) => navigated.push(to),
    );
    try {
      expect(container.textContent).toContain("My digest");
      expect(navigated).toEqual([]);
    } finally {
      cleanup(container, root);
    }
  });

  test("a name hops to the id address", async () => {
    const navigated: string[] = [];
    const { container, root } = await renderRoute(
      "my-digest",
      { tnt_1: [routineRecord({ id: "rtn_mine", name: "My digest" })] },
      (to) => navigated.push(to),
    );
    try {
      expect(navigated).toEqual(["/routines/rtn_mine"]);
    } finally {
      cleanup(container, root);
    }
  });

  test("a name two routines share offers both by id, and redirects to neither", async () => {
    const navigated: string[] = [];
    const { container, root } = await renderRoute(
      "my-digest",
      {
        tnt_1: [routineRecord({ id: "rtn_mine", name: "My digest" })],
        tnt_2: [routineRecord({ id: "rtn_theirs", name: "My digest" })],
      },
      (to) => navigated.push(to),
    );
    try {
      expect(container.textContent).toContain("More than one routine");
      const hrefs = [...container.querySelectorAll("a")].map((a) =>
        a.getAttribute("href"),
      );
      expect(hrefs).toContain("/routines/rtn_mine");
      expect(hrefs).toContain("/routines/rtn_theirs");
      expect(navigated).toEqual([]);
    } finally {
      cleanup(container, root);
    }
  });

  test("an unknown id says the routine is gone, never a silent roster", async () => {
    const navigated: string[] = [];
    const { container, root } = await renderRoute(
      "rtn_deleted",
      { tnt_1: [routineRecord({ id: "rtn_mine", name: "My digest" })] },
      (to) => navigated.push(to),
    );
    try {
      expect(container.textContent).toContain("That routine is gone");
      expect(container.textContent).toContain("Back to Routines");
      expect(navigated).toEqual([]);
    } finally {
      cleanup(container, root);
    }
  });

  test("an unknown name is gone too, with the same words", async () => {
    const { container, root } = await renderRoute(
      "no-such-routine",
      { tnt_1: [routineRecord({ id: "rtn_mine", name: "My digest" })] },
      () => {},
    );
    try {
      expect(container.textContent).toContain("That routine is gone");
    } finally {
      cleanup(container, root);
    }
  });
});
