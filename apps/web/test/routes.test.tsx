// Pages load through `React.lazy`, so these tests client-render and wait
// for the suspended route (SSR would only see the Suspense fallback). The
// one route with no stage bar of its own (`/`, see `AppRoute.hasStageTopBar`)
// gets one from `AppShell` itself, so every route ends up titled the same
// way - except the conversation route (`/w`), whose own conversation header
// IS its page identity (CL-6089): it renders no generic `StageTopBar` at
// all.

import { ThemeProvider } from "@corbits/react-ui";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { App } from "../src/app";
import { APP_ROUTES, matchesRoute, NAV_ROUTES } from "../src/routes";
import type { SessionState } from "../src/session";

/** Legacy routes that only redirect - `/library` bounces to `/files`
 * (CL-6353), `/settings/agents` and `/settings/skills` bounce to `/agents`
 * and `/skills` (CL-6354/CL-6355 moved both off Settings), `/inbox` bounces
 * home (the Inbox page is gone, CL-6151) - none has a stable panel title to
 * assert via the generic render loop below. */
const LEGACY_REDIRECT_PATHS = new Set([
  "/library",
  "/settings/agents",
  "/settings/skills",
  "/inbox",
]);

const noNavigate = () => undefined;
const noop = () => undefined;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const signedIn: SessionState = {
  kind: "signed-in",
  user: { id: "user_1", name: "Ada", email: "ada@example.com" },
};

function stubEmptyFetch(): void {
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
}

async function flushLazyImports(): Promise<void> {
  for (let count = 0; count < 5; count += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderApp(
  path: string,
  session: SessionState = signedIn,
): Promise<string> {
  stubEmptyFetch();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
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
    });
    await flushLazyImports();
    return container.innerHTML;
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
}

/** Page identity: every route titles its stage's own `StageTopBar` (the
 * one bar-less route, `/`, gets one from `AppShell` itself). */
function stagePageTitle(markup: string): string | undefined {
  return /<div class="stage-top-bar-title">([^<]*)<\/div>/.exec(markup)?.[1];
}

/** The sidebar footer marks its own destination current: Plugins and
 * Insights are text rows with `aria-current="page"` on the lit one.
 * Settings lives in the account menu, so its route lights nothing in the
 * chrome - the stage title carries it. Returns the active row's label so
 * tests confirm the *right* footer affordance lights, and nothing else
 * does. */
function activeFooterLabel(markup: string): string | undefined {
  const lit =
    /shell-sidebar-footer-row"[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/button>/.exec(
      markup,
    );
  if (lit === null) return undefined;
  return /<span>([^<]+)<\/span>/.exec(lit[1] ?? "")?.[1];
}

const FOOTER_LABELS: Record<string, string> = {
  "/routines": "Routines",
  "/files": "Files",
  "/skills": "Skills",
  "/agents": "Agents",
  "/plugins": "Plugins",
  "/insights": "Insights",
};

describe("route table", () => {
  test("covers every screen the app can route to", () => {
    expect(APP_ROUTES.map((route) => route.path)).toEqual([
      "/",
      "/new",
      "/w",
      "/inbox",
      "/routines",
      "/files",
      "/library",
      "/agents",
      "/settings/agents",
      "/skills",
      "/settings/skills",
      "/insights",
      "/plugins",
      "/settings",
    ]);
  });

  test("palette pages are Routines, Files, Skills, Agents, Insights, Settings", () => {
    expect(NAV_ROUTES.map((route) => route.label)).toEqual([
      "Routines",
      "Files",
      "Skills",
      "Agents",
      "Insights",
      "Settings",
    ]);
  });

  test("legacy /chat paths still match the workbenches route", () => {
    expect(matchesRoute("/w", "/chat")).toBe(true);
    expect(matchesRoute("/w", "/chat/ch_1")).toBe(true);
    expect(matchesRoute("/w", "/w/ch_1")).toBe(true);
  });

  test("/settings/:section stays on the settings route", () => {
    expect(matchesRoute("/settings", "/settings")).toBe(true);
    expect(matchesRoute("/settings", "/settings/people")).toBe(true);
    expect(matchesRoute("/settings", "/settings-lookalike")).toBe(false);
  });

  test("/agents/:id and /skills/:id stay on their own roster route", () => {
    expect(matchesRoute("/agents", "/agents/wfd_1")).toBe(true);
    expect(matchesRoute("/skills", "/skills/skill_1")).toBe(true);
    expect(NAV_ROUTES.map((route) => route.path)).toContain("/agents");
    expect(NAV_ROUTES.map((route) => route.path)).toContain("/skills");
  });

  test("legacy /settings/agents and /settings/skills stay routable (redirect-only, off the palette pages)", () => {
    expect(matchesRoute("/settings/agents", "/settings/agents/wfd_1")).toBe(
      true,
    );
    expect(matchesRoute("/settings/skills", "/settings/skills/skill_1")).toBe(
      true,
    );
    expect(NAV_ROUTES.map((route) => route.path)).not.toContain(
      "/settings/agents",
    );
    expect(NAV_ROUTES.map((route) => route.path)).not.toContain(
      "/settings/skills",
    );
  });

  test("legacy /library stays routable (redirect-only) but is off the palette pages", () => {
    expect(matchesRoute("/library", "/library/a/art_1")).toBe(true);
    expect(NAV_ROUTES.map((route) => route.path)).not.toContain("/library");
  });

  test("/inbox stays routable (redirect-only) but is off the palette pages", () => {
    expect(NAV_ROUTES.map((route) => route.path)).not.toContain("/inbox");
  });
});

describe("/inbox redirect", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  test("bounces old /inbox links home - the Inbox page is gone (CL-6151)", async () => {
    const inboxRoute = APP_ROUTES.find((route) => route.path === "/inbox");
    if (inboxRoute === undefined) throw new Error("no /inbox route entry");
    const navigated: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(inboxRoute.render("/inbox", (to) => navigated.push(to)));
    });
    expect(navigated).toEqual(["/"]);
  });
});

describe("routes render", () => {
  for (const route of APP_ROUTES) {
    if (LEGACY_REDIRECT_PATHS.has(route.path)) continue;
    test(`${route.path} renders the ${route.label} screen`, async () => {
      const markup = await renderApp(route.path);
      expect(markup).toContain('data-testid="shell-sidebar"');
      if (route.path === "/") {
        expect(stagePageTitle(markup)).toBe("New Workbench");
        return;
      }
      if (route.path === "/w") {
        expect(stagePageTitle(markup)).toBeUndefined();
        expect(markup).toContain('data-testid="shell-sidebar"');
        return;
      }
      if (route.path === "/settings") {
        expect(stagePageTitle(markup)).toBe("Settings · General");
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

  test("an unknown path renders the not-found screen", async () => {
    const markup = await renderApp("/no-such-screen");
    expect(markup).toContain("Page not found");
    expect(activeFooterLabel(markup)).toBeUndefined();
  });

  test("a /w/:workbenchId deep link waits for tenant resolution", async () => {
    const markup = await renderApp("/w/ch_deep");
    expect(markup).not.toContain('data-open="true"');
  });
});
