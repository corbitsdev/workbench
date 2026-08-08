// The far-left rail: global page nav with a visible label under each icon
// (not tooltip-only), plus settings and the bench switcher at the bottom —
// the two things the product correction moved out of the contextual panel.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { NAV_ROUTES, SETTINGS_PATH } from "../src/routes";
import { Rail } from "../src/shell/rail";

const noop = () => undefined;
const user = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };

// Rendered with react-dom/server: effects (and so `BenchProvider`'s own
// fetch) never run, which is exactly what these markup assertions want —
// `useBench` still needs a provider in the tree, it just never resolves.
globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.reject(new Error("no network in static rail tests"))) as typeof fetch;

function renderRail(path: string): string {
  return renderToStaticMarkup(
    <NavigationProvider navigate={noop}>
      <BenchProvider>
        <Rail path={path} onNavigate={noop} user={user} onSignOut={noop} />
      </BenchProvider>
    </NavigationProvider>,
  );
}

describe("Rail", () => {
  test("shows every page's label as visible text, not tooltip-only", () => {
    const markup = renderRail("/");
    for (const route of NAV_ROUTES) {
      expect(markup).toContain(
        `<span class="shell-rail-item-label">${route.label}</span>`,
      );
    }
  });

  test("marks the active page and no other", () => {
    const markup = renderRail("/chat");
    const currentCount = (markup.match(/aria-current="page"/g) ?? []).length;
    // One for the active page item, one for the (inactive) settings link.
    expect(currentCount).toBe(1);
    expect(markup).toMatch(
      /data-slot="sidebar-rail-item" aria-current="page"[^>]*>[\s\S]*?Chat/,
    );
  });

  test("carries the settings link and the bench switcher in its footer", () => {
    const markup = renderRail("/");
    expect(markup).toContain(`href="${SETTINGS_PATH}"`);
    expect(markup).toContain("shell-rail-footer");
  });

  test("never shows the account id", () => {
    expect(renderRail("/")).not.toContain("user_1");
  });
});
