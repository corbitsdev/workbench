// The async-mint setup state (CL-6272 follow-up): one honest headline for
// every waiting stage — the reader never sees which internal stage this
// is — plus a rotating product tip underneath so the pause reads as
// useful rather than dead. Proves the headline copy, that a tip renders,
// and that it rotates to the next one after the interval.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { WorkbenchTimeline } from "../src/timeline";
import { CHAT_STRINGS } from "../src/strings";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <WorkbenchTimeline items={[]} participants={[]} settingUpAgent />,
    );
  });
  return container;
}

describe("WorkbenchTimeline — setup loader", () => {
  test("shows one honest headline, never a system-stage name", () => {
    const el = mount();

    expect(el.textContent).toContain("Getting your workbench ready…");
    expect(el.textContent).not.toContain("runtime");
    expect(el.textContent).not.toContain("joining");
  });

  test("renders a rotating tip drawn from the shipped tip list", () => {
    const el = mount();

    const tip = el.querySelector(".chat-workbench-loading-tip");
    expect(tip).not.toBeNull();
    const tips: readonly string[] = CHAT_STRINGS.workbenchLoadingTips;
    expect(tips).toContain(tip?.textContent ?? "");
  });

  test("the tip advances to the next one after the rotation interval", async () => {
    const el = mount();
    const first = el.querySelector(".chat-workbench-loading-tip")?.textContent;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4050));
    });

    const second = el.querySelector(".chat-workbench-loading-tip")?.textContent;
    const expected: string = CHAT_STRINGS.workbenchLoadingTips[1] ?? "";
    expect(second).toBe(expected);
    expect(second).not.toBe(first);
  });
});

describe("WorkbenchTimeline — empty agent DM", () => {
  test("once the agent has joined, leads with its own name instead of the loader", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <WorkbenchTimeline
          items={[]}
          participants={[{ address: "myra@agents.example", handle: "myra" }]}
          settingUpAgent={false}
        />,
      );
    });

    expect(container.textContent).toContain("Say hello to Myra");
    expect(container.querySelector(".chat-workbench-loading")).toBeNull();
  });
});
