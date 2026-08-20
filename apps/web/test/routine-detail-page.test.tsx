// `/routines/<slug>` (CL-6418): the routine's own page — schedule as a
// sentence with the raw cron editable behind it, the target workflow with
// a way through to its steps, the whole fire history deep-linking into the
// run surface, and a health rail off telemetry the scheduler already
// records. Lifecycle actions (Run now, Pause/Resume) sit in the top bar's
// action slot and are wired to the routines package's existing mutations —
// never a button that does nothing.

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { NavigationProvider } from "../src/navigation";
import {
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
  lastFireAt: "2026-01-01T09:00:00.000Z",
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
});
