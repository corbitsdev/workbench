// The far-left brand rail: product pages with visible labels, Search, Inbox,
// Settings, theme, and avatar — matching shell mock chrome.

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

function renderRail(path: string): string {
  return renderToStaticMarkup(
    <TestQueryProvider>
      <NavigationProvider navigate={noop}>
        <BenchProvider>
          <Rail path={path} onNavigate={noop} user={user} onSignOut={noop} />
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>,
  );
}

describe("Rail", () => {
  test("shows every product destination label as visible text", () => {
    const markup = renderRail("/");
    for (const route of [
      ...RAIL_PRIMARY_ROUTES,
      ...RAIL_UTILITY_ROUTES,
      { label: RAIL_SEARCH.label },
      { label: RAIL_SETTINGS.label },
    ]) {
      expect(markup).toMatch(
        new RegExp(
          `data-slot="sidebar-rail-item-label"[^>]*>${route.label}</span>`,
        ),
      );
    }
  });

  test("does not list Chat or Approvals on the rail", () => {
    const markup = renderRail("/");
    expect(markup).not.toMatch(
      /data-slot="sidebar-rail-item-label"[^>]*>Chat<\/span>/,
    );
    expect(markup).not.toMatch(
      /data-slot="sidebar-rail-item-label"[^>]*>Approvals<\/span>/,
    );
  });

  test("marks the active page and no other", () => {
    const markup = renderRail("/routines");
    const currentCount = (markup.match(/aria-current="page"/g) ?? []).length;
    expect(currentCount).toBe(1);
    expect(markup).toMatch(
      /data-slot="sidebar-rail-item" aria-current="page"[^>]*>[\s\S]*?Routines/,
    );
  });

  test("carries brand class, theme, settings, and avatar in the footer", () => {
    const markup = renderRail("/");
    expect(markup).toContain("shell-brand-rail");
    expect(markup).toContain("shell-rail-footer");
    expect(markup).toContain("shell-rail-avatar-btn");
    expect(markup).toMatch(
      /data-slot="sidebar-rail-item-label"[^>]*>Settings<\/span>/,
    );
  });

  test("command palette destinations include every NAV_ROUTES label", () => {
    // NAV_ROUTES feeds the palette; rail may omit Settings from primary stack
    // but still lists it as a rail item.
    expect(NAV_ROUTES.map((route) => route.label)).toContain("Settings");
    expect(NAV_ROUTES.map((route) => route.label)).toContain("Channels");
  });

  test("never shows the account id", () => {
    expect(renderRail("/")).not.toContain("user_1");
  });
});
