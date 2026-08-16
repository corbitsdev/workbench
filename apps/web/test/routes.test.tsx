// Rendering here uses react-dom/server, so effects never run and every
// screen shows its pre-fetch state — which is exactly what these tests
// assert: each route mounts, names itself in its stage's own `StageTopBar`,
// and renders beside the one always-present sidebar. The one route with no
// stage bar of its own (`/`, see `AppRoute.hasStageTopBar`) gets one from
// `AppShell` itself, so every route ends up titled the same way — except
// the conversation route (`/c`), whose own conversation header IS its page
// identity (CL-6089): it renders no generic `StageTopBar` at all, static
// or otherwise, since a channel is never resolved in this unauthenticated
// static render.

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

/** Page identity: every route titles its stage's own `StageTopBar` (the
 * one bar-less route, `/`, gets one from `AppShell` itself). */
function stagePageTitle(markup: string): string | undefined {
  return /<div class="stage-top-bar-title">([^<]*)<\/div>/.exec(markup)?.[1];
}

/** The sidebar footer marks its own destination current: Insights and
 * Settings are icon buttons with `aria-label` + `aria-current`; the inbox
 * bell (a react-ui NotificationsBell inside a wrapper) marks its wrapper
 * with `data-active` instead. Returns the active destination's label so
 * tests confirm the *right* footer affordance lights, and nothing else
 * does. */
function activeFooterLabel(markup: string): string | undefined {
  if (/class="shell-sidebar-bell"[^>]*data-active="true"/.test(markup)) {
    return "Inbox";
  }
  const match =
    /aria-label="([^"]+)"[^>]*aria-current="page"/.exec(markup) ??
    /aria-current="page"[^>]*aria-label="([^"]+)"/.exec(markup);
  return match?.[1];
}

const FOOTER_LABELS: Record<string, string> = {
  "/inbox": "Inbox",
  "/insights": "Insights",
  "/plugins": "Plugins",
  "/settings": "Settings",
};

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
      "/plugins",
      "/settings",
    ]);
  });

  test("palette pages are Workbenches, Routines, Library, Insights, Inbox, Settings", () => {
    expect(NAV_ROUTES.map((route) => route.label)).toEqual([
      "Workbenches",
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

  test("legacy /agents and /skills stay routable (redirect-only, off the palette pages)", () => {
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
      // The one sidebar mounts on every route.
      expect(markup).toContain('data-testid="shell-sidebar"');
      // Myra land (`/`) titles its stage honestly for the screen it
      // actually shows first — the first-run prompt, not Myra herself
      // (CL-6124).
      if (route.path === "/") {
        expect(stagePageTitle(markup)).toBe("New Workbench");
        return;
      }
      // The conversation route titles itself via its own conversation
      // header, not a generic `StageTopBar` — asserting no stage bar
      // renders here is the regression guard for the double-header bug
      // CL-6089 fixed (a "Workbenches" bar over the channel's own header).
      if (route.path === "/c") {
        expect(stagePageTitle(markup)).toBeUndefined();
        expect(markup).toContain('data-testid="shell-sidebar"');
        return;
      }
      // Bare /settings' own redirect-to-first-section effect never runs in
      // this static render, so the stage bar honestly shows the section
      // it's actually resolved to (the first allowed one) rather than the
      // bare "Settings" the post-redirect URL would carry.
      if (route.path === "/settings") {
        expect(stagePageTitle(markup)).toBe("Settings · Notifications");
      } else {
        expect(stagePageTitle(markup)).toBe(route.label);
      }
      const footerLabel = FOOTER_LABELS[route.path];
      if (footerLabel !== undefined) {
        expect(activeFooterLabel(markup)).toBe(footerLabel);
      } else {
        expect(activeFooterLabel(markup)).toBeUndefined();
      }
    });
  }

  test("an unknown path renders the not-found screen", () => {
    const markup = renderApp("/no-such-screen");
    expect(markup).toContain("Page not found");
    expect(activeFooterLabel(markup)).toBeUndefined();
  });

  test("a /c/:channelId deep link waits for tenant resolution", () => {
    // Static rendering has no selected tenant, so the deep link cannot expose
    // channel state before the outer workbench scope resolves.
    const markup = renderApp("/c/ch_deep");
    expect(markup).toMatch(/class="shell-canvas-column"[^>]*data-open="false"/);
  });
});
