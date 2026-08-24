// CL-6833: mid-turn reopen whose catch-up fetch fails must not leave the
// room looking idle — a visible soft banner with Retry, never a silent
// swallow of `fetchRunningTurn(...).catch(() => undefined)`.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ResumeFailedBanner } from "../src/resume-failed-banner";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("ResumeFailedBanner (CL-6833)", () => {
  test("names the gap with a quotable ref and offers Retry, never a dead end", async () => {
    const retries: number[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ResumeFailedBanner
          refId="mt4ewrje-zvbmti"
          onRetry={() => retries.push(1)}
        />,
      );
    });

    const banner = container.querySelector(".chat-resume-failed-banner");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(container.textContent).toContain("Couldn't resume the running reply");
    expect(container.textContent).toContain("ref mt4ewrje-zvbmti");

    act(() => {
      (container?.querySelector("button") as HTMLButtonElement).click();
    });
    expect(retries).toEqual([1]);
  });
});
