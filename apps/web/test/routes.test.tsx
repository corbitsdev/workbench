// Rendering here uses react-dom/server, so effects never run and every
// screen shows its pre-fetch state — which is exactly what these tests
// assert: each route mounts, names itself in the contextual panel, and
// rail-listed pages mark themselves in the rail. Page identity lives in the
// panel page band (h2.panel-page-title), not a per-page TopBar.

import { ThemeProvider } from "@corbits/react-ui";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../src/app";
import { APP_ROUTES, matchesRoute, NAV_ROUTES } from "../src/routes";
import type { SessionState } from "../src/session";

/** Legacy routes that only redirect (see `pages/legacy-settings-redirects.tsx`)
 * — no stable panel title to assert via the generic SSR loop below. */
const LEGACY_REDIRECT_PATHS = new Set(["/agents", "/skills"]);

const noNavigate = () => undefined;
const noop = () => undefined;

const signedIn: SessionState = {
  kind: "signed-in",
  user: { id: "user_1", name: "Ada", email: "ada@example.com" },
};

function renderApp(path: string, session: SessionState = signedIn): string {
  return renderToStaticMarkup(
    <ThemeProvider>
      <App
        path={path}
        navigate={noNavigate}
        session={session}
        onSignedIn={noop}
        onSignOut={noop}
        onRetry={noop}
      />
    </ThemeProvider>,
  );
}

/** Page name from the contextual panel header (SidebarPanelHeader h2). */
function panelPageTitle(markup: string): string | undefined {
  return (
    /data-slot="sidebar-panel-header"[\s\S]*?<h2[^>]*>([^<]*)<\/h2>/.exec(
      markup,
    )?.[1] ??
    /class="panel-page-title"[^>]*>(.*?)<\/(?:span|h2)>/.exec(markup)?.[1]
  );
}

/** The rail marks exactly one page active at a time. Primary destinations
 * are `SidebarRail` items (`aria-current` + `sidebar-rail-item-label` when
 * `showLabels` is on). Inbox / Settings live in the footer as icon buttons
 * with `aria-label` + `aria-current` (see `shell/rail.tsx` FooterIconButton).
 * Returns the active destination's label so tests confirm the *right* page. */
function activeRailLabel(markup: string): string | undefined {
  const primary =
    /data-slot="sidebar-rail-item"[^>]*aria-current="page"[^>]*>[\s\S]*?<\/button>/.exec(
      markup,
    );
  if (primary !== null) {
    const label =
      /data-slot="sidebar-rail-item-label"[^>]*>([^<]*)<\/span>/.exec(
        primary[0],
      );
    if (label?.[1] !== undefined) return label[1];
  }
  // Footer utility (Inbox / Settings): aria-label is the accessible name.
  const footer =
    /class="shell-rail-footer-btn"[^>]*aria-label="([^"]+)"[^>]*aria-current="page"/.exec(
      markup,
    ) ??
    /class="shell-rail-footer-btn"[^>]*aria-current="page"[^>]*aria-label="([^"]+)"/.exec(
      markup,
    );
  return footer?.[1];
}

const NAV_PATHS = new Set(NAV_ROUTES.map((route) => route.path));

describe("route table", () => {
  test("covers every screen the app can route to", () => {
    expect(APP_ROUTES.map((route) => route.path)).toEqual([
      "/",
      "/c",
      "/inbox",
      "/routines",
      "/library",
      "/agents",
      "/skills",
      "/insights",
      "/settings",
    ]);
  });

  test("rail nav is Channels, Routines, Library, Insights, Inbox, Settings", () => {
    expect(NAV_ROUTES.map((route) => route.label)).toEqual([
      "Channels",
      "Routines",
      "Library",
      "Insights",
      "Inbox",
      "Settings",
    ]);
  });

  test("legacy /chat paths still match the channels route", () => {
    expect(matchesRoute("/c", "/chat")).toBe(true);
    expect(matchesRoute("/c", "/chat/ch_1")).toBe(true);
    expect(matchesRoute("/c", "/c/ch_1")).toBe(true);
  });

  test("/settings/:section stays on the settings route", () => {
    expect(matchesRoute("/settings", "/settings")).toBe(true);
    expect(matchesRoute("/settings", "/settings/people")).toBe(true);
    expect(matchesRoute("/settings", "/settings-lookalike")).toBe(false);
  });

  test("legacy /agents and /skills stay routable (redirect-only, off the rail)", () => {
    expect(matchesRoute("/agents", "/agents/wfd_1")).toBe(true);
    expect(matchesRoute("/skills", "/skills/skill_1")).toBe(true);
    expect(NAV_ROUTES.map((route) => route.path)).not.toContain("/agents");
    expect(NAV_ROUTES.map((route) => route.path)).not.toContain("/skills");
  });
});

describe("routes render", () => {
  for (const route of APP_ROUTES) {
    if (LEGACY_REDIRECT_PATHS.has(route.path)) continue;
    test(`${route.path} renders the ${route.label} screen`, () => {
      const markup = renderApp(route.path);
      // Myra land (`/`) lights Channels on the rail; panel title stays Myra.
      if (route.path === "/") {
        expect(panelPageTitle(markup)).toBe("Myra");
        expect(activeRailLabel(markup)).toBe("Channels");
        return;
      }
      expect(panelPageTitle(markup)).toBe(route.label);
      if (NAV_PATHS.has(route.path)) {
        expect(activeRailLabel(markup)).toBe(route.label);
      } else {
        expect(activeRailLabel(markup)).toBeUndefined();
      }
    });
  }

  test("an unknown path renders the not-found screen", () => {
    const markup = renderApp("/no-such-screen");
    expect(markup).toContain("Page not found");
    expect(markup).not.toContain('aria-current="page"');
  });

  test("a /c/:channelId deep link waits for tenant resolution", () => {
    // Static rendering has no selected tenant, so the deep link cannot expose
    // channel state before the outer workbench scope resolves.
    const markup = renderApp("/c/ch_deep");
    expect(markup).toMatch(/class="shell-canvas-column"[^>]*data-open="false"/);
  });
});
