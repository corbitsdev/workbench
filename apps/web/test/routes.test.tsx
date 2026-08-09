// Rendering here uses react-dom/server, so effects never run and every
// screen shows its pre-fetch state — which is exactly what these tests
// assert: each route mounts, names itself, and marks itself in the rail.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../src/app";
import { APP_ROUTES, SETTINGS_PATH } from "../src/routes";
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

function pageHeading(markup: string): string | undefined {
  return /<h1[^>]*>(.*?)<\/h1>/.exec(markup)?.[1];
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

describe("route table", () => {
  test("covers the eight screens", () => {
    expect(APP_ROUTES.map((route) => route.path)).toEqual([
      "/",
      "/chat",
      "/workflows",
      "/library",
      "/agents",
      "/skills",
      "/approvals",
      "/settings",
    ]);
  });
});

describe("routes render", () => {
  for (const route of APP_ROUTES) {
    test(`${route.path} renders the ${route.label} screen`, () => {
      const markup = renderApp(route.path);
      expect(pageHeading(markup)).toBe(route.label);
      if (route.path === SETTINGS_PATH) {
        // Settings has no page-nav entry in the rail — it is reached from
        // the rail's own identity dock instead.
        expect(markup).toMatch(/aria-current="page"[^>]*href="\/settings"/);
      } else {
        expect(activeRailLabel(markup)).toBe(route.label);
      }
    });
  }

  test("an unknown path renders the not-found screen", () => {
    const markup = renderApp("/no-such-screen");
    expect(markup).toContain("Page not found");
    expect(markup).not.toContain('aria-current="page"');
  });
});
