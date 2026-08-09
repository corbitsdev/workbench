// Rendering here uses react-dom/server, so effects never run and every
// screen shows its pre-fetch state — which is exactly what these tests
// assert: each route mounts, names itself in the contextual panel, and
// rail-listed pages mark themselves in the rail. Page identity lives in the
// panel page band (h2.panel-page-title), not a per-page TopBar.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../src/app";
import { APP_ROUTES, NAV_ROUTES, SETTINGS_PATH } from "../src/routes";
import type { SessionState } from "../src/session";

const noNavigate = () => undefined;
const noop = () => undefined;

const signedIn: SessionState = {
  kind: "signed-in",
  user: { id: "user_1", name: "Ada", email: "ada@example.com" },
};

function renderApp(path: string, session: SessionState = signedIn): string {
  return renderToStaticMarkup(
    <App
      path={path}
      navigate={noNavigate}
      session={session}
      onSignedIn={noop}
      onSignOut={noop}
      onRetry={noop}
    />,
  );
}

/** Page name from the contextual panel's page band (TopBars are gone). */
function panelPageTitle(markup: string): string | undefined {
  return /class="panel-page-title"[^>]*>(.*?)<\/h2>/.exec(markup)?.[1];
}

/** The rail marks exactly one page active at a time (an icon+label button,
 * not a link — see `shell/rail.tsx`); this resolves its visible caption so a
 * test can confirm it is the *right* page, not merely that some page is
 * active. The caption lives in `SidebarRail`'s `sidebar-rail-item-label`
 * slot (its `showLabels` mode), keyed off the active item's `data-slot`. */
function activeRailLabel(markup: string): string | undefined {
  const active =
    /data-slot="sidebar-rail-item"[^>]*aria-current="page"[^>]*>[\s\S]*?<\/button>/.exec(
      markup,
    );
  if (active === null) return undefined;
  const label = /data-slot="sidebar-rail-item-label"[^>]*>([^<]*)<\/span>/.exec(
    active[0],
  );
  return label?.[1];
}

const NAV_PATHS = new Set(NAV_ROUTES.map((route) => route.path));

describe("route table", () => {
  test("covers every screen the app can route to", () => {
    expect(APP_ROUTES.map((route) => route.path)).toEqual([
      "/",
      "/chat",
      "/routines",
      "/library",
      "/agents",
      "/skills",
      "/insights",
      "/approvals",
      "/settings",
    ]);
  });

  test("rail nav is Home, Routines, Library, Agents, Skills, Insights", () => {
    expect(NAV_ROUTES.map((route) => route.label)).toEqual([
      "Home",
      "Routines",
      "Library",
      "Agents",
      "Skills",
      "Insights",
    ]);
  });
});

describe("routes render", () => {
  for (const route of APP_ROUTES) {
    test(`${route.path} renders the ${route.label} screen`, () => {
      const markup = renderApp(route.path);
      expect(panelPageTitle(markup)).toBe(route.label);
      if (route.path === SETTINGS_PATH) {
        // Settings has no page-nav entry in the rail — it is reached from
        // the rail's own identity dock instead.
        expect(markup).toMatch(/aria-current="page"[^>]*href="\/settings"/);
      } else if (NAV_PATHS.has(route.path)) {
        expect(activeRailLabel(markup)).toBe(route.label);
      } else {
        // Chat and Approvals stay deep-linkable but leave the rail.
        expect(activeRailLabel(markup)).toBeUndefined();
        expect(markup).not.toMatch(
          new RegExp(
            `data-slot="sidebar-rail-item-label"[^>]*>${route.label}</span>`,
          ),
        );
      }
    });
  }

  test("an unknown path renders the not-found screen", () => {
    const markup = renderApp("/no-such-screen");
    expect(markup).toContain("Page not found");
    expect(markup).not.toContain('aria-current="page"');
  });
});
