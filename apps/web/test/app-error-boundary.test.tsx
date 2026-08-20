// CL-6381: a render error anywhere in the tree used to leave the reader
// staring at a blank white page (no error boundary existed anywhere in
// apps/web). This pins the boundary's red/green behaviour — a throwing
// child renders the designed EmptyState, never a blank screen — and that
// a healthy tree passes straight through untouched.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { AppErrorBoundary } from "../src/app-error-boundary";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
});

function Bomb(): never {
  throw new Error("kaboom");
}

function render(children: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<AppErrorBoundary>{children}</AppErrorBoundary>));
  return container;
}

describe("AppErrorBoundary", () => {
  test("a healthy tree passes straight through", () => {
    const el = render(<p>Everything is fine</p>);
    expect(el.textContent).toContain("Everything is fine");
  });

  test("a throwing child renders the empty state, not a blank screen", () => {
    // React logs the caught error to the real console during this render;
    // that's expected noise for a deliberately-throwing test component.
    const originalError = console.error;
    console.error = () => undefined;
    let el: HTMLDivElement;
    try {
      el = render(<Bomb />);
    } finally {
      console.error = originalError;
    }
    expect(el.textContent).toContain("This screen hit a snag");
    expect(el.textContent).toContain("Reload");
    expect(el.textContent).not.toContain("Everything is fine");
  });
});
