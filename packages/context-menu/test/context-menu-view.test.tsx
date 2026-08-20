import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Dialog, DialogContent, DialogTitle } from "@corbits/react-ui";

import { contextMenuItem } from "../src/menu";
import { ContextMenuView } from "../src/context-menu-view";
import type { ContextMenu } from "../src/menu";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Radix's exit animation handling runs through a couple of microtasks/rAF
 * frames even with no real CSS animation configured (happy-dom reports a
 * 0s duration, but `Presence` still waits an animationend-equivalent tick).
 * A couple of flushed macrotasks is enough for it to settle in tests. */
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(0);
    await sleep(0);
  });
}

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    render: (element: ReturnType<typeof createElement>) =>
      act(() => {
        root.render(element);
      }),
    unmount: () => act(() => root.unmount()),
  };
}

function menuWith(onSelect: () => void): ContextMenu {
  return {
    entries: [contextMenuItem({ id: "open", label: "Open", onSelect })],
  };
}

function pressEscape() {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    document.dispatchEvent(event);
  });
}

describe("ContextMenuView focus restoration", () => {
  test("Escape closes the menu and returns focus to the triggering row", async () => {
    const harness = mount();
    const row = document.createElement("button");
    row.textContent = "Launch Planning";
    document.body.appendChild(row);
    row.focus();

    function Host() {
      const [open, setOpen] = useState(true);
      return createElement(ContextMenuView, {
        x: 10,
        y: 10,
        menu: menuWith(() => undefined),
        open,
        restoreFocusTo: row,
        onOpenChange: setOpen,
      });
    }

    await harness.render(createElement(Host));
    await flush();
    expect(document.querySelector('[data-slot="menu-content"]')).not.toBeNull();

    pressEscape();
    await flush();

    expect(document.querySelector('[data-slot="menu-content"]')).toBeNull();
    expect(document.activeElement).toBe(row);
    harness.unmount();
    row.remove();
  });

  test("selecting an item closes the menu and returns focus to the triggering row", async () => {
    const harness = mount();
    const row = document.createElement("button");
    row.textContent = "Nightly Digest";
    document.body.appendChild(row);
    row.focus();
    let selected = false;

    function Host() {
      const [open, setOpen] = useState(true);
      return createElement(ContextMenuView, {
        x: 10,
        y: 10,
        menu: menuWith(() => {
          selected = true;
        }),
        open,
        restoreFocusTo: row,
        onOpenChange: setOpen,
      });
    }

    await harness.render(createElement(Host));
    await flush();

    const item = document.querySelector<HTMLElement>('[data-slot="menu-item"]');
    if (item === null) throw new Error("menu item did not render");
    act(() => {
      item.click();
    });
    await flush();

    expect(selected).toBe(true);
    expect(document.querySelector('[data-slot="menu-content"]')).toBeNull();
    expect(document.activeElement).toBe(row);
    harness.unmount();
    row.remove();
  });
});

describe("ContextMenuView danger styling", () => {
  test("a danger item gets destructive styling; a plain item does not", async () => {
    const harness = mount();
    const menu: ContextMenu = {
      entries: [
        contextMenuItem({
          id: "open",
          label: "Open",
          onSelect: () => undefined,
        }),
        contextMenuItem({
          id: "sign-out",
          label: "Sign out",
          onSelect: () => undefined,
          danger: true,
        }),
      ],
    };

    await harness.render(
      createElement(ContextMenuView, {
        x: 10,
        y: 10,
        menu,
        open: true,
        onOpenChange: () => undefined,
      }),
    );
    await flush();

    const items = document.querySelectorAll<HTMLElement>(
      '[data-slot="menu-item"]',
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.className).not.toContain("text-destructive");
    expect(items[1]?.className).toContain("text-destructive");
    harness.unmount();
  });
});

describe("ContextMenuView Esc precedence", () => {
  test("Escape closes the context menu but leaves an open dialog alone", async () => {
    const harness = mount();

    function Host() {
      const [dialogOpen, setDialogOpen] = useState(true);
      const [menuOpen, setMenuOpen] = useState(true);
      return createElement(
        "div",
        null,
        createElement(
          Dialog,
          { open: dialogOpen, onOpenChange: setDialogOpen },
          createElement(
            DialogContent,
            null,
            createElement(DialogTitle, null, "Rename channel"),
          ),
        ),
        createElement(ContextMenuView, {
          x: 10,
          y: 10,
          menu: menuWith(() => undefined),
          open: menuOpen,
          onOpenChange: setMenuOpen,
        }),
      );
    }

    await harness.render(createElement(Host));
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="menu-content"]')).not.toBeNull();

    pressEscape();
    await flush();

    expect(document.querySelector('[data-slot="menu-content"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    harness.unmount();
  });
});
