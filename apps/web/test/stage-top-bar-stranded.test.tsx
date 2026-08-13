// The shell enforces the "toggle is always reachable" invariant itself: a
// stage state that renders no StageTopBar (signed-out notice, home error,
// chat tenant-loading, library no-tenant, ...) still gets a col2 control,
// because AppShell renders a fallback toggle whenever no real toggle is
// registered. Narrow users can always open the drawer; wide users can
// always restore a collapsed col2.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AppShell } from "../src/shell/app-shell";
import { COMPACT_MAX_WIDTH, NARROW_MAX_WIDTH } from "../src/shell/breakpoints";
import { ShellChromeProvider } from "../src/shell/shell-chrome-provider";
import { StageTopBar } from "../src/shell/stage-top-bar";
import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const realFetch = globalThis.fetch;
const realMatchMedia = window.matchMedia;

afterEach(() => {
  globalThis.fetch = realFetch;
  window.matchMedia = realMatchMedia;
});

function stubMatchMedia(matching: Record<string, boolean>): void {
  window.matchMedia = ((media: string) =>
    ({
      media,
      matches: matching[media] ?? false,
      addEventListener: noop,
      removeEventListener: noop,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

const emptyMemberships = () =>
  new Response(JSON.stringify({ data: [], nextCursor: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const user = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };

function Harness({ children }: { readonly children: React.ReactNode }) {
  return (
    <TestQueryProvider>
      <NavigationProvider navigate={noop}>
        <BenchProvider>
          <ShellChromeProvider path="/inbox" navigate={noop}>
            <AppShell path="/inbox" user={user} onSignOut={noop}>
              {children}
            </AppShell>
          </ShellChromeProvider>
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>
  );
}

describe("stage states without a top bar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(emptyMemberships())) as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function toggle(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle sidebar"]',
    );
    if (button === null) throw new Error("no col2 toggle in the tree");
    return button;
  }

  test("narrow layout: a bar-less page still gets a control that opens the drawer", async () => {
    stubMatchMedia({
      [`(max-width: ${String(NARROW_MAX_WIDTH - 1)}px)`]: true,
      [`(max-width: ${String(COMPACT_MAX_WIDTH - 1)}px)`]: true,
    });
    await act(async () => {
      root.render(<Harness>{"Signed out"}</Harness>);
    });
    const fallback = toggle();
    expect(fallback.className).toContain("stage-toggle-fallback");
    const drawer = container.querySelector(".shell-drawer");
    if (drawer === null) throw new Error("drawer not rendered");
    expect(drawer.getAttribute("data-open")).toBe("false");

    await act(async () => {
      fallback.click();
    });
    expect(drawer.getAttribute("data-open")).toBe("true");
  });

  test("wide layout: collapsing col2 then swapping to a bar-less page keeps a restore control", async () => {
    stubMatchMedia({});
    await act(async () => {
      root.render(
        <Harness>
          <StageTopBar title="Inbox" />
        </Harness>,
      );
    });
    // The real toggle suppresses the fallback — exactly one control.
    expect(
      container.querySelectorAll('button[aria-label="Toggle sidebar"]').length,
    ).toBe(1);
    expect(container.querySelector(".stage-toggle-fallback")).toBeNull();

    await act(async () => {
      toggle().click();
    });
    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).toBeNull();

    // Route swaps to a state that renders no top bar.
    await act(async () => {
      root.render(<Harness>{"Signed out"}</Harness>);
    });
    const fallback = toggle();
    expect(fallback.className).toContain("stage-toggle-fallback");

    await act(async () => {
      fallback.click();
    });
    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).not.toBeNull();
  });
});
