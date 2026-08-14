import { describe, expect, test } from "bun:test";
import { act, createElement, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RefObject } from "react";

import { useScrollReset } from "../src/shell/use-scroll-reset";

function mount(initialPath: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let setPath: (path: string) => void = () => {};
  let scrollEl: HTMLDivElement | null = null;

  function Host() {
    const [path, updatePath] = useState(initialPath);
    setPath = updatePath;
    const ref = useRef<HTMLDivElement>(null);
    useScrollReset(ref as RefObject<HTMLDivElement | null>, path);
    return createElement(
      "div",
      {
        ref: (node: HTMLDivElement | null) => {
          scrollEl = node;
          (ref as { current: HTMLDivElement | null }).current = node;
        },
        style: { overflow: "auto", height: "40px" },
      },
      createElement("div", { style: { height: "400px" } }),
    );
  }

  act(() => {
    root.render(createElement(Host));
  });

  return {
    setScrollTop: (value: number) => {
      if (scrollEl !== null) scrollEl.scrollTop = value;
    },
    setPath: (path: string) =>
      act(() => {
        setPath(path);
      }),
    getScrollTop: () => scrollEl?.scrollTop ?? -1,
    unmount: () => root.unmount(),
  };
}

describe("useScrollReset", () => {
  test("resets scrollTop when the route dependency changes", () => {
    const harness = mount("/library");
    harness.setScrollTop(240);
    expect(harness.getScrollTop()).toBe(240);
    harness.setPath("/agents");
    expect(harness.getScrollTop()).toBe(0);
    harness.unmount();
  });
});
