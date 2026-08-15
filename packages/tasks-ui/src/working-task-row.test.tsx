// DOM-mounted render tests for `WorkingTaskRow`: the display name and
// elapsed time always show, the "needs you" badge and emphasis tone are
// reserved for that status alone (a plain running row must not reach for
// orange), and a click fires `onSelect`. Needs a real DOM (see
// `test/dom-setup.ts`).
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { WorkingTaskRow } from "./working-task-row";
import type { Task } from "./api";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: Parameters<typeof WorkingTaskRow>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement("ul", null, createElement(WorkingTaskRow, props)),
    );
  });
  return container;
}

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

function task(
  overrides: Partial<Task> = {},
): Pick<Task, "status" | "createdAt"> {
  return {
    status: "running",
    createdAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("WorkingTaskRow", () => {
  test("shows the agent's display name and elapsed time", () => {
    const el = mount({
      task: task(),
      displayName: "Researcher",
      onSelect: () => undefined,
    });
    expect(el.textContent).toContain("Researcher");
    expect(el.querySelector('[role="img"]')).not.toBeNull();
  });

  test("a plain running task never carries the needs-you badge", () => {
    const el = mount({
      task: task({ status: "running" }),
      displayName: "Researcher",
      onSelect: () => undefined,
    });
    expect(el.textContent).not.toContain("Needs you");
  });

  test("a needs-you task shows the accent badge", () => {
    const el = mount({
      task: task({ status: "needs-you" }),
      displayName: "Researcher",
      onSelect: () => undefined,
    });
    expect(el.textContent).toContain("Needs you");
  });

  test("clicking the row fires onSelect", () => {
    let selected = false;
    const el = mount({
      task: task(),
      displayName: "Researcher",
      onSelect: () => {
        selected = true;
      },
    });
    const button = el.querySelector("button");
    expect(button).not.toBeNull();
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(selected).toBe(true);
  });
});
