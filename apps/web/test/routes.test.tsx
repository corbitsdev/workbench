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

  test("rail nav is Channels, Routines, Library, Agents, Skills, Insights, Inbox, Settings", () => {
    expect(NAV_ROUTES.map((route) => route.label)).toEqual([
      "Channels",
      "Routines",
      "Library",
      "Agents",
      "Skills",
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
});

describe("routes render", () => {
  for (const route of APP_ROUTES) {
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

  test("a /c/:channelId deep link opens the canvas on first paint", () => {
    // Canvas state is seeded from the path (not effect-only), so static
    // markup sees the open column without running useEffect.
    const markup = renderApp("/c/ch_deep");
    expect(markup).toMatch(/class="shell-canvas-column"[^>]*data-open="true"/);
  });
});
