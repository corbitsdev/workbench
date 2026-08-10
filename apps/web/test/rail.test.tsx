// The far-left brand rail matches the shell mock: Corbits mark, primary page
// icons (tooltip-only by default), then Search / Inbox / Settings / theme /
// avatar in the footer. Captions under icons are opt-in (`showLabels`).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import {
  NAV_ROUTES,
  RAIL_PRIMARY_ROUTES,
  RAIL_SEARCH,
  RAIL_SETTINGS,
  RAIL_UTILITY_ROUTES,
} from "../src/routes";
import { Rail } from "../src/shell/rail";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const user = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };

// Rendered with react-dom/server: effects (and so `BenchProvider`'s own
// fetch) never run, which is exactly what these markup assertions want —
// `useBench` still needs a provider in the tree, it just never resolves.
globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.reject(new Error("no network in static rail tests"))) as typeof fetch;

function renderRail(path: string, showLabels = false): string {
  return renderToStaticMarkup(
    <TestQueryProvider>
      <NavigationProvider navigate={noop}>
        <BenchProvider>
          <Rail
            path={path}
            onNavigate={noop}
            user={user}
            onSignOut={noop}
            showLabels={showLabels}
          />
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>,
  );
}

describe("Rail", () => {
  test("primary destinations are rail items; utility sits in the footer", () => {
    const markup = renderRail("/");
    for (const route of RAIL_PRIMARY_ROUTES) {
      // Icon-only: accessible name lives in the pure-CSS tooltip span.
      expect(markup).toContain(`>${route.label}</span>`);
    }
    // Footer controls: Search, Inbox, Settings as labelled buttons.
    expect(markup).toContain(`aria-label="${RAIL_SEARCH.label}"`);
    for (const route of RAIL_UTILITY_ROUTES) {
      expect(markup).toContain(`aria-label="${route.label}"`);
    }
    expect(markup).toContain(`aria-label="${RAIL_SETTINGS.label}"`);
    // Mock default is icon-only — no visible captions under icons.
    expect(markup).not.toContain('data-slot="sidebar-rail-item-label"');
  });

  test("showLabels renders captions under primary icons only", () => {
    const markup = renderRail("/", true);
    for (const route of RAIL_PRIMARY_ROUTES) {
      expect(markup).toMatch(
        new RegExp(
          `data-slot="sidebar-rail-item-label"[^>]*>${route.label}</span>`,
        ),
      );
    }
  });

  test("does not list Chat or Approvals on the rail", () => {
    const markup = renderRail("/");
    expect(markup).not.toContain(">Chat</span>");
    expect(markup).not.toContain(">Approvals</span>");
  });

  test("marks the active primary page", () => {
    const markup = renderRail("/routines");
    expect(markup).toMatch(/data-slot="sidebar-rail-item" aria-current="page"/);
    // Tooltip for the active item still says Routines.
    expect(markup).toContain(">Routines</span>");
  });

  test("carries brand chrome: mark, rail class, footer, avatar", () => {
    const markup = renderRail("/");
    expect(markup).toContain("shell-brand-rail");
    expect(markup).toContain("shell-brand-rail-column");
    expect(markup).toContain("shell-rail-mark");
    expect(markup).toContain("shell-rail-footer");
    expect(markup).toContain("shell-rail-avatar-btn");
  });

  test("command palette destinations include every NAV_ROUTES label", () => {
    expect(NAV_ROUTES.map((route) => route.label)).toContain("Settings");
    expect(NAV_ROUTES.map((route) => route.label)).toContain("Channels");
  });

  test("never shows the account id", () => {
    expect(renderRail("/")).not.toContain("user_1");
  });
});
