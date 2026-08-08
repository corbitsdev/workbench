// Rendering here uses react-dom/server, so effects never run and every
// screen shows its pre-fetch state — which is exactly what these tests
// assert: each route mounts, names itself, and marks itself in the rail.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../src/app";
import { APP_ROUTES } from "../src/routes";
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

describe("route table", () => {
  test("covers the seven screens", () => {
    expect(APP_ROUTES.map((route) => route.path)).toEqual([
      "/",
      "/chat",
      "/runs",
      "/library",
      "/approvals",
      "/benches",
      "/settings",
    ]);
  });
});

describe("routes render", () => {
  for (const route of APP_ROUTES) {
    test(`${route.path} renders the ${route.label} screen`, () => {
      const markup = renderApp(route.path);
      expect(pageHeading(markup)).toBe(route.label);
      const active = new RegExp(
        `aria-current="page"[^>]*href="${route.path.replaceAll("/", "\\/")}"`,
      );
      expect(markup).toMatch(active);
    });
  }

  test("an unknown path renders the not-found screen", () => {
    const markup = renderApp("/no-such-screen");
    expect(markup).toContain("Page not found");
    expect(markup).not.toContain('aria-current="page"');
  });
});
