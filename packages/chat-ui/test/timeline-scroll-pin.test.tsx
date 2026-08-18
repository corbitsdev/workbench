// CL-6252 #4: a sibling mounting or growing below the scroll container
// (the turn-activity strip, a typing indicator) changes the container's
// own available height without changing `items.length` — the effect that
// re-anchors scrollTop on `items.length` never fires for it. This proves
// `ChannelTimeline` wires a `ResizeObserver` on its scroll container that
// re-anchors to the bottom while pinned, and leaves an unpinned reader's
// scrollTop alone.
//
// happy-dom's `ResizeObserver` never fires from real layout (there is no
// layout engine), so this stubs the constructor to capture the callback
// the component registered and invokes it directly — the same shape of
// seam `use-typing-indicator.test.tsx` uses for real timers, just for a
// browser observer instead.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { MessageItem } from "../src/api";
import { ChannelTimeline } from "../src/timeline";

const realResizeObserver = globalThis.ResizeObserver;

class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  readonly callback: ResizeObserverCallback;
  observed: Element | null = null;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    StubResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed = target;
  }
  unobserve() {
    this.observed = null;
  }
  disconnect() {
    this.observed = null;
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
  StubResizeObserver.instances = [];
});

function items(): MessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "hello" }],
      sender: { name: "Researcher", address: "researcher@agents.example" },
    },
  ];
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount() {
  globalThis.ResizeObserver =
    StubResizeObserver as unknown as typeof ResizeObserver;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ChannelTimeline items={items()} />);
  });
  const scrollEl = container.querySelector(".chat-timeline") as HTMLElement;
  Object.defineProperty(scrollEl, "scrollHeight", {
    value: 900,
    configurable: true,
  });
  return { container, scrollEl };
}

describe("ChannelTimeline re-anchors on container resize while pinned (CL-6252 #4)", () => {
  test("a resize while pinned scrolls back to the bottom", async () => {
    const { scrollEl } = await mount();
    scrollEl.scrollTop = 0;

    const observer = StubResizeObserver.instances[0];
    expect(observer?.observed).toBe(scrollEl);
    act(() => observer?.fire());

    expect(scrollEl.scrollTop).toBe(900);
  });

  test("a resize while the reader has scrolled up never yanks their position", async () => {
    const { scrollEl } = await mount();
    // Simulate the reader scrolling away from the bottom — past
    // `BOTTOM_PIN_THRESHOLD_PX` — which flips `pinnedRef` false.
    Object.defineProperty(scrollEl, "clientHeight", {
      value: 200,
      configurable: true,
    });
    act(() => {
      scrollEl.scrollTop = 100;
      scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    const observer = StubResizeObserver.instances[0];
    act(() => observer?.fire());

    expect(scrollEl.scrollTop).toBe(100);
  });

  test("the observer disconnects on unmount", async () => {
    await mount();
    const observer = StubResizeObserver.instances[0];
    expect(observer?.observed).not.toBeNull();
    act(() => root?.unmount());
    root = null;
    expect(observer?.observed).toBeNull();
  });
});
