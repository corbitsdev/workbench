import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { contextMenuItem } from "../src/menu";
import { useDocumentContextMenuTrigger } from "../src/use-document-context-menu-trigger";
import type { ContextMenu } from "../src/menu";

const MENU: ContextMenu = {
  entries: [
    contextMenuItem({ id: "open", label: "Open", onSelect: () => undefined }),
  ],
};

function mount(resolve: (target: EventTarget | null) => ContextMenu | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const opens: {
    x: number;
    y: number;
    menu: ContextMenu;
    origin: Element | null;
  }[] = [];

  function Host() {
    useDocumentContextMenuTrigger({
      resolve,
      onOpen: (x, y, menu, origin) => opens.push({ x, y, menu, origin }),
    });
    return null;
  }

  act(() => {
    root.render(createElement(Host));
  });

  return {
    opens,
    unmount: () => act(() => root.unmount()),
  };
}

function fireContextMenu(
  target: EventTarget,
  coords: { x: number; y: number },
) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: coords.x,
    clientY: coords.y,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("useDocumentContextMenuTrigger", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("opens the resolved menu at the click point, carrying the clicked element as origin", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    const harness = mount(() => MENU);

    const event = fireContextMenu(row, { x: 12, y: 34 });

    expect(event.defaultPrevented).toBe(true);
    expect(harness.opens).toEqual([{ x: 12, y: 34, menu: MENU, origin: row }]);
    harness.unmount();
  });

  test("leaves the native menu alone when resolve finds nothing", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    const harness = mount(() => null);

    const event = fireContextMenu(row, { x: 0, y: 0 });

    expect(event.defaultPrevented).toBe(false);
    expect(harness.opens).toEqual([]);
    harness.unmount();
  });

  test("leaves the native menu alone for an empty menu", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    const harness = mount(() => ({ entries: [] }));

    fireContextMenu(row, { x: 0, y: 0 });

    expect(harness.opens).toEqual([]);
    harness.unmount();
  });

  test("does not intercept a right-click on a text input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const harness = mount(() => MENU);

    const event = fireContextMenu(input, { x: 0, y: 0 });

    expect(event.defaultPrevented).toBe(false);
    expect(harness.opens).toEqual([]);
    harness.unmount();
  });

  test("does not intercept while a dialog is open", () => {
    const row = document.createElement("div");
    document.body.appendChild(row);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    const harness = mount(() => MENU);

    const event = fireContextMenu(row, { x: 0, y: 0 });

    expect(event.defaultPrevented).toBe(false);
    expect(harness.opens).toEqual([]);
    harness.unmount();
  });
});
