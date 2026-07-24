/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import {
  CommandPalette,
  PALETTE_PANEL_MAX_WIDTH_CLASS,
  PALETTE_PANEL_MOTION,
} from "./CommandPalette";
import type { PaletteResultItem } from "@workbench/shared";

const navItems: PaletteResultItem[] = [
  { id: "nav:chats", category: "navigation", title: "Chats", to: "/chats" },
  {
    id: "nav:artifacts",
    category: "navigation",
    title: "Artifacts",
    to: "/library/artifacts",
  },
];

const entityItems: PaletteResultItem[] = [
  {
    id: "conversation:c1",
    category: "conversation",
    title: "Acme onboarding",
    to: "/chats/c1",
  },
];

type Overrides = Partial<React.ComponentProps<typeof CommandPalette>>;

// The component is controlled, so the harness owns query state to mirror the
// provider; tests drive it through the input.
function Harness({
  open = true,
  onClose,
  onSelect,
  overrides,
}: {
  open?: boolean;
  onClose: () => void;
  onSelect: (item: PaletteResultItem) => void;
  overrides?: Overrides;
}) {
  const [query, setQuery] = useState(overrides?.query ?? "");
  return (
    <CommandPalette
      open={open}
      onClose={onClose}
      onSelect={onSelect}
      query={query}
      onQueryChange={setQuery}
      navItems={navItems}
      entityItems={entityItems}
      {...overrides}
    />
  );
}

function renderPalette(overrides?: Overrides) {
  const onClose = mock(() => {});
  const onSelect = mock((_item: PaletteResultItem) => {});
  render(React.createElement(Harness, { onClose, onSelect, overrides }));
  const input = screen.getByRole("combobox") as HTMLInputElement;
  return { onClose, onSelect, input };
}

afterEach(() => cleanup());

describe("CommandPalette", () => {
  it("uses the combobox/listbox ARIA roles, not a dialog", () => {
    renderPalette();
    screen.getByRole("combobox");
    screen.getByRole("listbox");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("groups nav and entity results under category headers", () => {
    renderPalette();
    screen.getByText("Go to");
    screen.getByText("Conversations");
  });

  it("fuzzy-filters nav commands client-side as the query changes", () => {
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: "artif" } });
    // Titles are split into highlight spans, so match on concatenated text.
    const titles = screen
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(titles.some((t) => t.includes("Artifacts"))).toBe(true);
    expect(titles.some((t) => t.includes("Chats"))).toBe(false);
  });

  it("shows server entity results without client-side filtering", () => {
    // 'zzzz' matches no nav command, but the server-provided entity stays —
    // entity matching is the server's job, not the client's.
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: "zzzz" } });
    screen.getByRole("option", { name: /Acme onboarding/ });
  });

  it("shows an empty state when nothing matches and not loading", () => {
    renderPalette({ navItems: [], entityItems: [], query: "nope" });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    screen.getByText(/No matches/);
  });

  it("shows a searching state while loading with no results yet", () => {
    renderPalette({
      navItems: [],
      entityItems: [],
      query: "ac",
      loading: true,
    });
    screen.getByText(/Searching/);
  });

  it("shows an error state when the search failed", () => {
    renderPalette({
      navItems: [],
      entityItems: [],
      query: "ac",
      error: true,
    });
    screen.getByText(/Search failed/);
  });

  it("moves the active row up and down with the Arrow keys", () => {
    const { input } = renderPalette();
    expect(
      screen.getAllByRole("option")[0]!.getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getAllByRole("option")[1]!.getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(
      screen.getAllByRole("option")[0]!.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("navigates the active row on Enter", () => {
    const { input, onSelect } = renderPalette();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].id).toBe("nav:artifacts");
  });

  it("selects a row on click", () => {
    const { onSelect } = renderPalette();
    fireEvent.click(screen.getByRole("option", { name: /Acme onboarding/ }));
    expect(onSelect.mock.calls[0]![0].id).toBe("conversation:c1");
  });

  it("closes on Escape", () => {
    const { input, onClose } = renderPalette();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Enter and Arrow keys while an IME composition is active", () => {
    const { input, onSelect } = renderPalette();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getAllByRole("option")[0]!.getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("calls onLoadMore from the load-more control when more pages exist", () => {
    const onLoadMore = mock(() => {});
    renderPalette({ hasMore: true, onLoadMore });
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("focuses the input when open flips false→true and restores focus on close", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // The provider keeps the palette mounted; opening is a prop flip, not a
    // mount. Closed first: no input, focus stays on the trigger.
    const { rerender } = render(
      React.createElement(Harness, {
        open: false,
        onClose: () => {},
        onSelect: () => {},
      }),
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    rerender(
      React.createElement(Harness, {
        open: true,
        onClose: () => {},
        onSelect: () => {},
      }),
    );
    const input = screen.getByRole("combobox");
    expect(document.activeElement).toBe(input);

    rerender(
      React.createElement(Harness, {
        open: false,
        onClose: () => {},
        onSelect: () => {},
      }),
    );
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("restores focus to the previously-focused element on unmount", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      React.createElement(Harness, {
        onClose: () => {},
        onSelect: () => {},
      }),
    );
    expect(document.activeElement).not.toBe(trigger);

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("renders an enlarged panel and shortcut footer with global hints", () => {
    renderPalette();
    const panel = screen.getByTestId("command-palette-panel");
    expect(panel.className).toContain(PALETTE_PANEL_MAX_WIDTH_CLASS);
    const footer = screen.getByTestId("command-palette-footer");
    expect(footer.textContent).toContain("Open command palette");
    expect(footer.textContent).toContain("Attach to Myra");
    expect(footer.textContent).toMatch(/⌘K|Ctrl\+K/);
    expect(footer.textContent).toMatch(/⌘I|Ctrl\+I/);
    expect(footer.textContent).toContain("Navigate");
    expect(footer.textContent).toContain("Esc");
  });

  it("shows nav groups on idle open so the palette is useful before typing", () => {
    renderPalette();
    screen.getByText("Go to");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    screen.getByText(/Search entities or pick a destination below/);
  });

  it("uses an opacity-only transition with no scale or translate (brand guard)", () => {
    const frames = [
      PALETTE_PANEL_MOTION.initial,
      PALETTE_PANEL_MOTION.animate,
      PALETTE_PANEL_MOTION.exit,
    ] as const;
    for (const frame of frames) {
      const keys = Object.keys(frame);
      expect(keys).toEqual(["opacity"]);
      expect(keys).not.toContain("scale");
      expect(keys).not.toContain("x");
      expect(keys).not.toContain("y");
      expect(keys).not.toContain("rotate");
    }
  });
});
