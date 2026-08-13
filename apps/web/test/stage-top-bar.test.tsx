// The shared stage top bar: one bar on every stage surface with the single
// col2 collapse control top-left, title · dot · subtitle, right-aligned
// page actions, and breadcrumb trails in the title slot. The shell flips a
// real collapsed state — collapsing removes col2 from the flow, and there
// is no other collapse control anywhere in the shell.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { useState } from "react";

import { AppShell } from "../src/shell/app-shell";
import { COMPACT_MAX_WIDTH, NARROW_MAX_WIDTH } from "../src/shell/breakpoints";
import { ShellChromeProvider } from "../src/shell/shell-chrome-provider";
import { StageChromeProvider } from "../src/shell/stage-chrome";
import { StageCrumbs, StageTopBar } from "../src/shell/stage-top-bar";
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

describe("StageTopBar", () => {
  test("renders toggle, title, dot, subtitle, and actions", () => {
    const markup = renderToStaticMarkup(
      <StageTopBar
        title="Inbox"
        subtitle="2 need action · 5 open"
        actions={<button type="button">Mark all read</button>}
      />,
    );
    expect(markup).toContain('aria-label="Toggle sidebar"');
    expect(markup).toContain("Inbox");
    expect(markup).toContain("stage-top-bar-dot");
    expect(markup).toContain("2 need action · 5 open");
    expect(markup).toContain("Mark all read");
  });

  test("omits the dot when there is no subtitle", () => {
    const markup = renderToStaticMarkup(<StageTopBar title="Skills" />);
    expect(markup).not.toContain("stage-top-bar-dot");
    expect(markup).not.toContain("stage-top-bar-sub");
  });

  test("reflects the collapsed state on the toggle", () => {
    const markup = renderToStaticMarkup(
      <StageChromeProvider
        value={{
          col2Collapsed: true,
          col2Width: "collapsed",
          toggleCol2: noop,
          registerToggle: () => noop,
          toggleMounted: true,
        }}
      >
        <StageTopBar title="Library" />
      </StageChromeProvider>,
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="shell-col2"');
  });
});

describe("StageCrumbs", () => {
  test("renders trail buttons and marks the last crumb current", () => {
    const markup = renderToStaticMarkup(
      <StageCrumbs
        crumbs={[{ label: "Runs", onSelect: noop }, { label: "Morning brief" }]}
      />,
    );
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain(">Runs</button>");
    expect(markup).toContain('aria-current="page">Morning brief</span>');
    expect(markup).toContain("stage-crumbs-sep");
  });
});

type StubQuery = {
  media: string;
  matches: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

function stubMatchMedia(matching: Record<string, boolean>): void {
  window.matchMedia = ((media: string): MediaQueryList => {
    const query: StubQuery = {
      media,
      matches: matching[media] ?? false,
      addEventListener: noop,
      removeEventListener: noop,
    };
    return query as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

const emptyMemberships = () =>
  new Response(JSON.stringify({ data: [], nextCursor: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const user = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };

function ShellHarness({ path = "/inbox" }: { readonly path?: string }) {
  return (
    <TestQueryProvider>
      <NavigationProvider navigate={noop}>
        <BenchProvider>
          <ShellChromeProvider path={path} navigate={noop}>
            <AppShell path={path} user={user} onSignOut={noop}>
              <StageTopBar title="Inbox" />
            </AppShell>
          </ShellChromeProvider>
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>
  );
}

describe("shell col2 collapse", () => {
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

  function toggleButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle sidebar"]',
    );
    if (button === null) throw new Error("toggle not rendered");
    return button;
  }

  test("the top bar toggle removes and restores col2", async () => {
    stubMatchMedia({});
    await act(async () => {
      root.render(<ShellHarness />);
    });

    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      toggleButton().click();
    });
    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).toBeNull();
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      toggleButton().click();
    });
    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).not.toBeNull();
    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
  });

  test("navigation resets a collapsed col2", async () => {
    stubMatchMedia({});
    await act(async () => {
      root.render(<ShellHarness path="/inbox" />);
    });
    await act(async () => {
      toggleButton().click();
    });
    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).toBeNull();

    await act(async () => {
      root.render(<ShellHarness path="/routines" />);
    });
    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).not.toBeNull();
    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
  });

  test("narrow layout has no floating drawer trigger — the toggle opens the drawer", async () => {
    stubMatchMedia({
      [`(max-width: ${String(NARROW_MAX_WIDTH - 1)}px)`]: true,
      [`(max-width: ${String(COMPACT_MAX_WIDTH - 1)}px)`]: true,
    });
    await act(async () => {
      root.render(<ShellHarness />);
    });

    expect(container.querySelector(".shell-drawer-trigger")).toBeNull();
    const drawer = container.querySelector(".shell-drawer");
    if (drawer === null) throw new Error("drawer not rendered");
    expect(drawer.getAttribute("data-open")).toBe("false");

    await act(async () => {
      toggleButton().click();
    });
    expect(drawer.getAttribute("data-open")).toBe("true");
  });
});

describe("StageChromeProvider wiring", () => {
  test("toggle flips the provided state", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <StageChromeProvider
          value={{
            col2Collapsed: collapsed,
            col2Width: collapsed ? "collapsed" : "normal",
            toggleCol2: () => setCollapsed((value) => !value),
            registerToggle: () => noop,
            toggleMounted: true,
          }}
        >
          <StageTopBar title="Agents" />
        </StageChromeProvider>
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle sidebar"]',
    );
    if (button === null) throw new Error("toggle not rendered");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      button.click();
    });
    expect(button.getAttribute("aria-expanded")).toBe("false");

    act(() => root.unmount());
    container.remove();
  });
});
