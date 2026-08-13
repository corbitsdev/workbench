import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { contextMenuItem } from "../src/menu";
import { useContextMenuState } from "../src/use-context-menu-state";
import type { ContextMenuState } from "../src/use-context-menu-state";

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let latest: ContextMenuState | undefined;

  function Host() {
    latest = useContextMenuState();
    return null;
  }

  act(() => {
    root.render(createElement(Host));
  });

  return {
    get state() {
      if (latest === undefined) throw new Error("not rendered yet");
      return latest;
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("useContextMenuState", () => {
  test("starts closed with no menu and no trigger element", () => {
    const harness = mount();
    expect(harness.state.open).toBe(false);
    expect(harness.state.menu).toBeNull();
    expect(harness.state.triggerElement).toBeNull();
    harness.unmount();
  });

  test("show opens at the given position with the given menu", () => {
    const harness = mount();
    const menu = {
      entries: [
        contextMenuItem({
          id: "open",
          label: "Open",
          onSelect: () => undefined,
        }),
      ],
    };
    act(() => harness.state.show(120, 340, menu));
    expect(harness.state.open).toBe(true);
    expect(harness.state.x).toBe(120);
    expect(harness.state.y).toBe(340);
    expect(harness.state.menu).toEqual(menu);
    harness.unmount();
  });

  test("show records the trigger element when given one", () => {
    const harness = mount();
    const menu = {
      entries: [
        contextMenuItem({
          id: "open",
          label: "Open",
          onSelect: () => undefined,
        }),
      ],
    };
    const row = document.createElement("div");
    act(() => harness.state.show(0, 0, menu, row));
    expect(harness.state.triggerElement).toBe(row);
    harness.unmount();
  });

  test("hide closes without discarding the last menu content", () => {
    const harness = mount();
    const menu = {
      entries: [
        contextMenuItem({
          id: "open",
          label: "Open",
          onSelect: () => undefined,
        }),
      ],
    };
    act(() => harness.state.show(0, 0, menu));
    act(() => harness.state.hide());
    expect(harness.state.open).toBe(false);
    expect(harness.state.menu).toEqual(menu);
    harness.unmount();
  });
});
