// CL-6568: the pre-send banner a tenant with no usable model sees before
// typing into a workbench with an agent in it — never a silently
// disabled composer, always a visible, actionable "Connect a model".
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { NoUsableModelBanner } from "../src/no-usable-model-banner";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("NoUsableModelBanner", () => {
  test("names the gap and offers to connect, never a dead end", async () => {
    const connected: number[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <NoUsableModelBanner onConnectModel={() => connected.push(1)} />,
      );
    });

    expect(container.querySelector(".chat-no-model-banner")).not.toBeNull();
    expect(container.textContent).toContain("No model is connected");

    act(() => {
      (container?.querySelector("button") as HTMLButtonElement).click();
    });
    expect(connected).toEqual([1]);
  });
});
