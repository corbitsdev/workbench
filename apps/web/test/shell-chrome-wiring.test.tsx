// Regression test for the context-tree bug the coordinator caught in review:
// app.tsx's Shell mounts CommandPaletteProvider and AppShell as siblings, so
// a hook CommandPaletteProvider called (useStageChrome, useCloseCanvas) only
// saw a real value if the provider supplying it wrapped BOTH siblings —
// providers that wrapped AppShell's own subtree handed CommandPaletteProvider
// nothing but the context's no-op default. That made the palette's
// "Close canvas" and "Toggle sidebar" actions silent no-ops against the real
// shell, even though their unit tests (command-palette-actions.test.ts) pass,
// because those tests mock the action context directly rather than mounting
// the provider tree.
//
// ShellChromeProvider now owns col2 and canvas state above both siblings.
// This test mounts that real tree — no mocked context — and drives the
// actions the same way CommandPaletteProvider's handleSelect does: through
// the real `runActionCommand`, sourcing `toggleCol2`/`closeCanvas` from a
// sibling of AppShell via the exact hooks CommandPaletteProvider uses. It
// does not re-test the palette's own UI (react-ui's CommandPalette,
// exercised elsewhere) — the bug was in the context tree, not the widget.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useStageChrome } from "@corbits/shell-layout";
import { AppShell } from "../src/shell/app-shell";
import { BenchProvider } from "../src/bench-context";
import { runActionCommand } from "../src/command-palette-actions";
import { NavigationProvider } from "../src/navigation";
import {
  useCloseCanvas,
  useOpenProfileInCanvas,
} from "../src/shell/canvas-availability";
import { ShellChromeProvider } from "../src/shell/shell-chrome-provider";
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

const sampleProfile = {
  kind: "member" as const,
  address: "ada@example.com",
  handle: "ada",
  displayName: "Ada",
  initials: "AD",
};

/** Stands in for CommandPaletteProvider's position in app.tsx's Shell — a
 * sibling of AppShell, not a descendant — without pulling in the full
 * palette widget. Sources its action context from the same hooks
 * CommandPaletteProvider does, and fires real actions through the real
 * `runActionCommand`. */
function PaletteActionsProbe() {
  const { toggleCol2 } = useStageChrome();
  const closeCanvas = useCloseCanvas();
  const openProfile = useOpenProfileInCanvas();

  const ctx = {
    path: "/inbox",
    navigate: noop,
    tenantId: null,
    cycleTheme: noop,
    closeCanvas,
    toggleCol2,
  };

  return (
    <div>
      <button
        type="button"
        data-testid="probe-open-profile"
        onClick={() => openProfile(sampleProfile)}
      >
        Open profile
      </button>
      <button
        type="button"
        data-testid="probe-close-canvas"
        onClick={() => void runActionCommand("close-canvas", ctx)}
      >
        Close canvas
      </button>
      <button
        type="button"
        data-testid="probe-toggle-sidebar"
        onClick={() => void runActionCommand("toggle-sidebar", ctx)}
      >
        Toggle sidebar
      </button>
    </div>
  );
}

function Harness() {
  return (
    <TestQueryProvider>
      <NavigationProvider navigate={noop}>
        <BenchProvider>
          <ShellChromeProvider path="/inbox" navigate={noop}>
            <PaletteActionsProbe />
            <AppShell path="/inbox" user={user} onSignOut={noop}>
              {"Inbox"}
            </AppShell>
          </ShellChromeProvider>
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>
  );
}

describe("palette actions reach the real shell state (CL-5936 sibling-context regression)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubMatchMedia({});
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

  function click(testId: string): void {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (button === null) throw new Error(`${testId} not rendered`);
    button.click();
  }

  test("toggle-sidebar fired from a sibling of AppShell collapses and restores col2", async () => {
    await act(async () => {
      root.render(<Harness />);
    });
    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      click("probe-toggle-sidebar");
    });
    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).toBeNull();

    await act(async () => {
      click("probe-toggle-sidebar");
    });
    expect(
      container.querySelector('[data-testid="shell-contextual-panel"]'),
    ).not.toBeNull();
  });

  test("close-canvas fired from a sibling of AppShell closes a canvas AppShell is showing", async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    await act(async () => {
      click("probe-open-profile");
    });
    expect(
      container.querySelector('.shell-canvas-column[data-open="true"]'),
    ).not.toBeNull();

    await act(async () => {
      click("probe-close-canvas");
    });
    expect(
      container.querySelector('.shell-canvas-column[data-open="true"]'),
    ).toBeNull();
  });
});
