// The shell enforces "col2 collapsed → expand affordance at the boundary"
// itself, purely from col2's own collapsed state — never from whether the
// current page happens to render its own StageTopBar. AppShell renders the
// edge handle whenever col2 is collapsed, with or without a bar-having page
// mounted below it. Narrow users can always open the drawer; wide users can
// always restore a collapsed col2.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { COMPACT_MAX_WIDTH, NARROW_MAX_WIDTH } from "@corbits/shell-layout";
import { AppShell } from "../src/shell/app-shell";
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

describe("col2 expand affordance without a page top bar", () => {
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

  function edgeHandle(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand sidebar"]',
    );
    if (button === null) throw new Error("no edge handle in the tree");
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
    const handle = edgeHandle();
    expect(handle.className).toContain("shell-col2-edge-handle");
    const drawer = container.querySelector(".shell-drawer");
    if (drawer === null) throw new Error("drawer not rendered");
    expect(drawer.getAttribute("data-open")).toBe("false");

    await act(async () => {
      handle.click();
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
    // Col2 starts open — its own toggle is the only control, no edge handle yet.
    expect(container.querySelector(".shell-col2-edge-handle")).toBeNull();
    const collapseButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse sidebar"]',
    );
    if (collapseButton === null)
      throw new Error("collapse control not on col2");

    await act(async () => {
      collapseButton.click();
    });
    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).toBeNull();

    // Route swaps to a state that renders no top bar — the affordance stays.
    await act(async () => {
      root.render(<Harness>{"Signed out"}</Harness>);
    });
    const handle = edgeHandle();
    expect(handle.className).toContain("shell-col2-edge-handle");

    await act(async () => {
      handle.click();
    });
    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).not.toBeNull();
  });
});
