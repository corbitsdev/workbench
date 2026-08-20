// CL-6370: every page/room-level wait renders the shared warm loader —
// headline + rotating tip — never a bare skeleton/spinner slab, and a wait
// that resolves inside the delay window never renders an intermediate
// frame at all (flash prevention).

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { WorkbenchLoadingState } from "../src/loading-state";
import { CHAT_STRINGS } from "../src/strings";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function mount(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
  return container;
}

describe("WorkbenchLoadingState", () => {
  test("renders the tips treatment, never a bare skeleton", () => {
    const el = mount(<WorkbenchLoadingState delayMs={0} />);

    expect(el.querySelector(".chat-workbench-loading")).not.toBeNull();
    expect(el.querySelector(".chat-workbench-loading-tip")).not.toBeNull();
    expect(el.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(el.querySelector(".animate-pulse")).toBeNull();
  });

  test("shows the default honest headline", () => {
    const el = mount(<WorkbenchLoadingState delayMs={0} />);

    expect(el.textContent).toContain(CHAT_STRINGS.workbenchLoadingTitle);
  });

  test("accepts a title override for a non-workbench surface", () => {
    const el = mount(
      <WorkbenchLoadingState delayMs={0} title="Loading routines…" />,
    );

    expect(el.textContent).toContain("Loading routines…");
  });

  test("renders nothing until the delay elapses (flash prevention)", async () => {
    const el = mount(<WorkbenchLoadingState delayMs={200} />);

    expect(el.querySelector(".chat-workbench-loading")).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });

    expect(el.querySelector(".chat-workbench-loading")).not.toBeNull();
  });
});
