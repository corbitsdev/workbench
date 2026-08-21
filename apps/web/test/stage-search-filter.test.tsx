// DECISIONS.md → Search: the stage top bar's magnifier filters the page it
// is on — it is not a door into the global command palette, and it never
// was meant to be one after CL-6487/CL-6410 conflated the two (PR #246).
// This suite covers the per-page filter surface in isolation: a page hands
// in its own `value`/`onChange`, and the magnifier morphs into a plain
// input that drives that state directly, never the palette's open store.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";

import {
  setCommandPaletteOpen,
  useCommandPaletteOpen,
} from "../src/command-palette-open-store";
import { StageTopBar } from "../src/shell/stage-top-bar";

const appCss = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");

function ruleFor(css: string, className: string): string {
  const selector = new RegExp(`\\.${className}\\s*[,{]`);
  const block = css.split("}").find((candidate) => selector.test(candidate));
  if (block === undefined) throw new Error(`no rule for .${className}`);
  return block.slice(block.indexOf("{"));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setCommandPaletteOpen(false);
});

function render(node: React.ReactElement): void {
  act(() => {
    root.render(node);
  });
}

function magnifier(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="stage-search"] button',
  );
  if (button === null) throw new Error("no magnifier rendered");
  return button;
}

function filterInput(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    '[data-testid="stage-search"] input',
  );
}

function Harness({ filterable = true }: { readonly filterable?: boolean }) {
  const [value, setValue] = useState("");
  // Reads the global palette's open state alongside the filter, so a test
  // can assert typing in the page filter never touches it.
  const globalOpen = useCommandPaletteOpen();
  return (
    <>
      <span data-testid="global-open">{String(globalOpen)}</span>
      <StageTopBar
        crumbs={[{ label: "Files" }]}
        {...(filterable
          ? {
              filter: {
                label: "Filter files",
                placeholder: "Filter by name",
                value,
                onChange: setValue,
              },
            }
          : {})}
      />
    </>
  );
}

describe("the stage top bar's per-page filter", () => {
  test("a page with a filter shows a magnifier that morphs into an input", () => {
    render(<Harness />);
    expect(filterInput()).toBeNull();

    act(() => magnifier().click());

    const input = filterInput();
    expect(input).not.toBeNull();
    expect(input?.getAttribute("aria-label")).toBe("Filter files");
    expect(input?.getAttribute("placeholder")).toBe("Filter by name");
  });

  test("typing filters the page directly and never opens the global palette", () => {
    render(<Harness />);
    act(() => magnifier().click());

    const input = filterInput();
    if (input === null) throw new Error("no filter input");
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setValue === undefined) throw new Error("no native value setter");
    act(() => {
      setValue.call(input, "invoice");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(filterInput()?.value).toBe("invoice");
    expect(
      container.querySelector('[data-testid="global-open"]')?.textContent,
    ).toBe("false");
  });

  test("Escape clears the query first, then collapses back to the magnifier", () => {
    render(<Harness />);
    act(() => magnifier().click());

    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    const input = filterInput();
    if (input === null || setValue === undefined)
      throw new Error("setup failed");
    act(() => {
      setValue.call(input, "invoice");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    act(() => {
      filterInput()?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(filterInput()?.value).toBe("");

    act(() => {
      filterInput()?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(filterInput()).toBeNull();
    expect(document.activeElement).toBe(magnifier());
  });

  test("a page with nothing to filter renders no magnifier at all", () => {
    render(<Harness filterable={false} />);
    expect(container.querySelector('[data-testid="stage-search"]')).toBeNull();
  });

  test("the magnifier keeps its 40px minimum hit target", () => {
    const rule = ruleFor(appCss, "stage-search-button");
    expect(rule).toContain("width: 2.75rem");
    expect(rule).toContain("height: 2.75rem");
  });
});
